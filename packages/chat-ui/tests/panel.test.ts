// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createChat } from "../src/core/chat.js";
import { mountAskAiPanel } from "../src/core/panel/index.js";
import { chunk, controlledStream, DONE, memoryStorage, sseResponse } from "./helpers.js";

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function mount(responder: () => Response = () => sseResponse([chunk("Sunny"), DONE])) {
  const chat = createChat({
    endpoint: "/api/ask-ai",
    agent: "weather-bot",
    storage: memoryStorage(),
    fetchImpl: (async () => responder()) as unknown as typeof fetch,
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const panel = mountAskAiPanel(container, chat);

  const q = <T extends Element>(selector: string) => container.querySelector<T>(selector)!;
  return {
    chat,
    panel,
    container,
    launcher: q<HTMLButtonElement>(".iri-chat-launcher"),
    surface: q<HTMLElement>(".iri-chat-surface"),
    input: q<HTMLInputElement>(".iri-chat-input"),
    form: q<HTMLFormElement>(".iri-chat-composer"),
    transcript: q<HTMLElement>(".iri-chat-transcript"),
    q,
  };
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("panel", () => {
  it("renders an edge control labelled Ask AI with the surface closed", () => {
    const { launcher, surface } = mount();

    expect(launcher.tagName).toBe("BUTTON");
    expect(launcher.textContent).toBe("Ask AI");
    expect(surface.hidden).toBe(true);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
  });

  it("opens on activation, moves focus in, and returns focus on close", () => {
    const { launcher, surface, input } = mount();

    launcher.click();
    expect(surface.hidden).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(launcher.getAttribute("aria-expanded")).toBe("true");

    launcher.click();
    expect(surface.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher);
  });

  it("closes on Escape", () => {
    const { launcher, surface, input } = mount();
    launcher.click();

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(surface.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher);
  });

  it("uses real buttons for every action", () => {
    const { container } = mount();
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(["Ask AI", "Clear conversation", "Close", "Send", "Stop"]),
    );
  });

  it("sends the composed message and streams the reply into the transcript", async () => {
    const { launcher, input, form, transcript } = mount();
    launcher.click();

    input.value = "what's the weather?";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(transcript.textContent).toContain("what's the weather?");
    expect(transcript.textContent).toContain("Sunny");
    expect(input.value).toBe("");
  });

  it("sends on Enter", async () => {
    const { launcher, input, transcript } = mount();
    launcher.click();

    input.value = "what's the weather?";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await settle();

    expect(transcript.textContent).toContain("Sunny");
    expect(input.value).toBe("");
  });

  it("does not send on Enter while an IME composition is open", async () => {
    const { launcher, input, transcript, chat } = mount();
    launcher.click();

    input.value = "とうきょう";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }),
    );
    await settle();

    expect(chat.getMessages()).toEqual([]);
    expect(transcript.textContent).toBe("");
  });

  it("swaps Send for Stop while a run is in flight", async () => {
    const stream = controlledStream();
    const { launcher, input, form, q, chat } = mount(() => stream.response);
    launcher.click();

    input.value = "long one";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(q<HTMLButtonElement>(".iri-chat-send").hidden).toBe(true);
    expect(q<HTMLButtonElement>(".iri-chat-cancel").hidden).toBe(false);

    q<HTMLButtonElement>(".iri-chat-cancel").click();
    await settle();

    expect(chat.isStreaming()).toBe(false);
    expect(q<HTMLButtonElement>(".iri-chat-send").hidden).toBe(false);
  });

  it("locks the composer while a slow slice is still resolving", async () => {
    const { launcher, input, form, q, chat } = mount();
    let release = () => {};
    chat.registry.register("slow", () => new Promise((resolve) => (release = () => resolve("v"))));
    launcher.click();

    input.value = "hi";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    // Nothing has reached the gateway yet, but the send is under way — the
    // composer must not look idle.
    expect(q<HTMLButtonElement>(".iri-chat-send").hidden).toBe(true);
    expect(q<HTMLButtonElement>(".iri-chat-cancel").hidden).toBe(false);
    expect(input.disabled).toBe(true);

    release();
    await settle();
    expect(q<HTMLButtonElement>(".iri-chat-send").hidden).toBe(false);
  });

  it("marks a cancelled turn without dressing it as an error", async () => {
    const stream = controlledStream();
    const { launcher, input, form, transcript, q } = mount(() => stream.response);
    launcher.click();
    input.value = "story";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    stream.push(chunk("Once upon"));
    await settle();

    q<HTMLButtonElement>(".iri-chat-cancel").click();
    await settle();

    expect(transcript.textContent).toContain("Once upon");
    expect(transcript.textContent).toContain("Stopped");
    expect(transcript.querySelector(".iri-chat-error")).toBeNull();
  });

  it("shows the gateway's error under the turn it belongs to", async () => {
    const { launcher, input, form, transcript } = mount(
      () =>
        new Response(JSON.stringify({ error: { code: "context_too_large", message: "too big" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    );
    launcher.click();
    input.value = "hi";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    expect(transcript.querySelector(".iri-chat-error")?.textContent).toContain("context_too_large");
  });

  it("empties the transcript on Clear conversation", async () => {
    const { launcher, input, form, transcript, q } = mount();
    launcher.click();
    input.value = "hi";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    expect(transcript.textContent).not.toBe("");

    [...q<HTMLElement>(".iri-chat-header").querySelectorAll("button")]
      .find((b) => b.textContent === "Clear conversation")!
      .click();

    expect(transcript.textContent).toBe("");
  });

  it("renders markdown and HTML as literal text", async () => {
    const { launcher, input, form, transcript } = mount(() =>
      sseResponse([chunk("**bold** and <script>alert(1)</script>"), DONE]),
    );
    launcher.click();
    input.value = "hi";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();

    const body = transcript.querySelector(".iri-chat-msg-assistant .iri-chat-msg-body")!;
    expect(body.textContent).toBe("**bold** and <script>alert(1)</script>");
    expect(body.querySelector("script")).toBeNull();
    expect(body.querySelector("strong")).toBeNull();
  });

  it("shows the caret only while streaming", async () => {
    const stream = controlledStream();
    const { launcher, input, form, transcript } = mount(() => stream.response);
    launcher.click();
    input.value = "hi";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    stream.push(chunk("partial"));
    await settle();

    expect(transcript.querySelector(".iri-chat-caret")).not.toBeNull();

    stream.push(DONE);
    stream.finish();
    await settle();

    expect(transcript.querySelector(".iri-chat-caret")).toBeNull();
  });

  it("removes its DOM and stops reacting once unmounted", async () => {
    const { panel, chat, container } = mount();
    const listener = vi.fn();
    chat.subscribe(listener);

    panel.unmount();
    expect(container.querySelector(".iri-chat-root")).toBeNull();

    await chat.send("hi");
    // The store still works; the panel simply is not listening any more.
    expect(container.querySelector(".iri-chat-transcript")).toBeNull();
    expect(listener).toHaveBeenCalled();
  });
});
