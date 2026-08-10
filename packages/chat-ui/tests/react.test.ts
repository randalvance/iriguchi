// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { act } from "react";
import { createElement, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskAiPanel } from "../src/react/panel.js";
import { IriguchiChatProvider, useIriChat, useIriContext } from "../src/react/index.js";
import { chunk, DONE, memoryStorage, sentBodies, sseResponse } from "./helpers.js";

afterEach(cleanup);

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 10));
});

function provider(children: ReactNode, fetchImpl: typeof fetch, storage = memoryStorage()) {
  return createElement(
    IriguchiChatProvider,
    { endpoint: "/api/ask-ai", agent: "weather-bot", fetchImpl, storage },
    children,
  );
}

/** A bare host built from the hooks alone — no panel, no stylesheet. */
function HooksHost() {
  const { messages, streaming, send, cancel, clear } = useIriChat();
  return createElement(
    "div",
    null,
    createElement("button", { onClick: () => void send("hi") }, "send"),
    createElement("button", { onClick: cancel }, "stop"),
    createElement("button", { onClick: clear }, "clear"),
    createElement("span", { "data-testid": "streaming" }, String(streaming)),
    createElement(
      "ol",
      { "data-testid": "messages" },
      messages.map((message, i) =>
        createElement("li", { key: i }, `${message.role}:${message.content}`),
      ),
    ),
  );
}

describe("react binding", () => {
  it("drives a conversation from the hooks alone", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([chunk("Sunny"), DONE]),
    ) as unknown as typeof fetch;
    render(provider(createElement(HooksHost), fetchImpl));

    act(() => screen.getByText("send").click());
    await settle();

    expect(screen.getByTestId("messages").textContent).toContain("assistant:Sunny");
    expect(screen.getByTestId("streaming").textContent).toBe("false");
  });

  it("registers and deregisters slices with the components that own them", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([chunk("ok"), DONE]));

    function Rows() {
      useIriContext("visibleRows", () => [1, 2, 3]);
      return null;
    }
    function Page() {
      const [showRows, setShowRows] = useState(true);
      useIriContext("route", () => "/city/tokyo");
      return createElement(
        "div",
        null,
        showRows ? createElement(Rows) : null,
        createElement("button", { onClick: () => setShowRows(false) }, "hide rows"),
        createElement(HooksHost),
      );
    }

    render(provider(createElement(Page), fetchImpl as unknown as typeof fetch));

    act(() => screen.getByText("send").click());
    await settle();

    // The unmount has to flush before the next send, or the slice would still
    // be registered and the assertion would pass for the wrong reason.
    act(() => screen.getByText("hide rows").click());
    act(() => screen.getByText("send").click());
    await settle();

    const bodies = sentBodies(fetchImpl);
    expect(bodies[0]?.["iri_context"]).toEqual({ route: "/city/tokyo", visibleRows: [1, 2, 3] });
    expect(bodies[1]?.["iri_context"]).toEqual({ route: "/city/tokyo" });
  });

  it("keeps the thread across a simulated navigation", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([chunk("ok"), DONE]));

    function App() {
      const [route, setRoute] = useState("/city/tokyo");
      useIriContext("route", () => route);
      return createElement(
        "div",
        null,
        createElement("button", { onClick: () => setRoute("/city/london") }, "navigate"),
        createElement(HooksHost),
      );
    }

    render(provider(createElement(App), fetchImpl as unknown as typeof fetch));

    act(() => screen.getByText("send").click());
    await settle();
    act(() => screen.getByText("navigate").click());
    act(() => screen.getByText("send").click());
    await settle();

    // Four messages: the conversation was not reset by the route change.
    expect(screen.getByTestId("messages").querySelectorAll("li")).toHaveLength(4);
    const bodies = sentBodies(fetchImpl);
    expect(bodies[1]?.["iri_context"]).toEqual({ route: "/city/london" });
  });

  it("restores a persisted thread on remount and drops it on clear", async () => {
    const storage = memoryStorage();
    const fetchImpl = vi.fn(async () =>
      sseResponse([chunk("Sunny"), DONE]),
    ) as unknown as typeof fetch;

    const first = render(provider(createElement(HooksHost), fetchImpl, storage));
    act(() => screen.getByText("send").click());
    await settle();
    first.unmount();

    render(provider(createElement(HooksHost), fetchImpl, storage));
    await waitFor(() =>
      expect(screen.getByTestId("messages").textContent).toContain("assistant:Sunny"),
    );

    act(() => screen.getByText("clear").click());
    await waitFor(() => expect(screen.getByTestId("messages").textContent).toBe(""));
  });

  it("mounts the same panel React-side", async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([chunk("Sunny"), DONE]),
    ) as unknown as typeof fetch;
    const { container, unmount } = render(provider(createElement(AskAiPanel), fetchImpl));

    const launcher = container.querySelector<HTMLButtonElement>(".iri-chat-launcher")!;
    expect(launcher.textContent).toBe("Ask AI");

    act(() => launcher.click());
    const input = container.querySelector<HTMLInputElement>(".iri-chat-input")!;
    input.value = "hi";
    container
      .querySelector<HTMLFormElement>(".iri-chat-composer")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(container.querySelector(".iri-chat-transcript")!.textContent).toContain("Sunny");

    unmount();
    expect(document.querySelector(".iri-chat-root")).toBeNull();
  });

  it("fails loudly when a hook is used outside the provider", () => {
    expect(() => render(createElement(HooksHost))).toThrowError(/IriguchiChatProvider/);
  });
});
