import type { Chat } from "../chat.js";
import type { ChatMessage } from "../types.js";

export interface PanelOptions {
  /** Label on the edge control and the accessible name of the surface. */
  label?: string;
  placeholder?: string;
}

export interface MountedPanel {
  unmount(): void;
  open(): void;
  close(): void;
  readonly element: HTMLElement;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  // textContent throughout: assistant replies are rendered as the characters
  // they are, so markdown stays literal and there is no markup to inject.
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderMessage(message: ChatMessage): HTMLElement {
  const wrap = el("div", `iri-chat-msg iri-chat-msg-${message.role}`);
  const body = el("div", "iri-chat-msg-body", message.content);
  wrap.appendChild(body);

  if (message.status === "streaming") {
    // The only thing distinguishing an in-flight reply from a finished one.
    body.appendChild(el("span", "iri-chat-caret"));
  }
  if (message.status === "cancelled") {
    wrap.appendChild(el("div", "iri-chat-note", "Stopped"));
  }
  if (message.status === "error") {
    wrap.appendChild(el("div", "iri-chat-error", message.error ?? "Something went wrong"));
  }
  return wrap;
}

/**
 * Builds the panel and keeps it in step with the chat store. This is the one
 * implementation of the panel; the React component wraps it rather than
 * repeating it, so the two cannot drift apart.
 */
export function mountAskAiPanel(
  container: HTMLElement,
  chat: Chat,
  options: PanelOptions = {},
): MountedPanel {
  const label = options.label ?? "Ask AI";

  const root = el("div", "iri-chat-root");
  const launcher = el("button", "iri-chat-launcher", label);
  launcher.type = "button";
  launcher.setAttribute("aria-expanded", "false");

  const surface = el("div", "iri-chat-surface");
  surface.setAttribute("role", "dialog");
  surface.setAttribute("aria-label", label);
  surface.hidden = true;

  const header = el("div", "iri-chat-header");
  header.appendChild(el("span", "iri-chat-title", label));
  const clearButton = el("button", "iri-chat-action", "Clear conversation");
  clearButton.type = "button";
  const closeButton = el("button", "iri-chat-action", "Close");
  closeButton.type = "button";
  header.append(clearButton, closeButton);

  const transcript = el("div", "iri-chat-transcript");
  transcript.setAttribute("aria-live", "polite");

  const form = el("form", "iri-chat-composer");
  const input = el("input", "iri-chat-input");
  input.type = "text";
  input.autocomplete = "off";
  input.placeholder = options.placeholder ?? "Ask about this page…";
  input.setAttribute("aria-label", "Message");
  const send = el("button", "iri-chat-send", "Send");
  send.type = "submit";
  const cancel = el("button", "iri-chat-cancel", "Stop");
  cancel.type = "button";
  cancel.hidden = true;
  form.append(input, send, cancel);

  surface.append(header, transcript, form);
  root.append(launcher, surface);
  container.appendChild(root);

  const render = () => {
    transcript.replaceChildren(...chat.getMessages().map(renderMessage));
    transcript.scrollTop = transcript.scrollHeight;
    const streaming = chat.isStreaming();
    send.hidden = streaming;
    cancel.hidden = !streaming;
    input.disabled = streaming;
  };

  const open = () => {
    surface.hidden = false;
    launcher.setAttribute("aria-expanded", "true");
    input.focus();
  };
  const close = () => {
    surface.hidden = true;
    launcher.setAttribute("aria-expanded", "false");
    launcher.focus();
  };

  const onLauncher = () => (surface.hidden ? open() : close());
  const submit = () => {
    const text = input.value;
    input.value = "";
    void chat.send(text);
  };
  const onSubmit = (event: Event) => {
    event.preventDefault();
    submit();
  };
  // Enter sends. A form with a submit button submits implicitly, but that is
  // the primary way anyone uses a chat box — too important to leave to a
  // default that an embedding page could interfere with.
  const onInputKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    submit();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !surface.hidden) close();
  };
  const onClear = () => {
    chat.clear();
    input.focus();
  };

  launcher.addEventListener("click", onLauncher);
  closeButton.addEventListener("click", close);
  clearButton.addEventListener("click", onClear);
  cancel.addEventListener("click", () => chat.cancel());
  form.addEventListener("submit", onSubmit);
  input.addEventListener("keydown", onInputKeydown);
  root.addEventListener("keydown", onKeydown);

  const unsubscribe = chat.subscribe(render);
  render();

  return {
    element: root,
    open,
    close,
    unmount() {
      unsubscribe();
      root.removeEventListener("keydown", onKeydown);
      root.remove();
    },
  };
}
