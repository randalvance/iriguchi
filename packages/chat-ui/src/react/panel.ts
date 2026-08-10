import { createElement, useEffect, useRef } from "react";
import { mountAskAiPanel, type PanelOptions } from "../core/panel/index.js";
import { useIriguchiChatInstance } from "./index.js";

export type AskAiPanelProps = PanelOptions;

/**
 * A wrapper over the framework-agnostic panel, not a second implementation of
 * it. The panel owns its subtree entirely and the chat store — not the DOM —
 * is the source of truth, which is what makes the imperative mount safe here.
 */
export function AskAiPanel(props: AskAiPanelProps = {}) {
  const chat = useIriguchiChatInstance();
  const host = useRef<HTMLDivElement | null>(null);
  const { label, placeholder } = props;

  useEffect(() => {
    const container = host.current;
    if (container === null) return;
    const panel = mountAskAiPanel(container, chat, { label, placeholder });
    return () => panel.unmount();
  }, [chat, label, placeholder]);

  return createElement("div", { ref: host });
}
