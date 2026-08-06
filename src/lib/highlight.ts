import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import rustLang from "@shikijs/langs/rust";
import vesperTheme from "@shikijs/themes/vesper";

/**
 * Shared Rust syntax highlighter.
 *
 * Deliberately a fine-grained shiki bundle. Importing `codeToHtml` from "shiki"
 * pulls in EVERY bundled grammar plus the Oniguruma wasm binary — that alone was
 * ~10MB across ~300 lazy chunks (emacs-lisp, wolfram, cpp, vue-vine, ...) for an
 * app that only ever highlights Rust. Core + one grammar + one theme + the JS
 * regex engine is a few KB.
 *
 * The instance is created once and reused; both the policy code editor and the
 * rules page render Rust.
 */
let highlighterPromise: Promise<HighlighterCore> | null = null;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    langs: [rustLang],
    themes: [vesperTheme],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

/** Highlight Rust source as themed HTML. Returns null if highlighting fails. */
export async function highlightRust(code: string): Promise<string | null> {
  try {
    const highlighter = await getHighlighter();
    return highlighter.codeToHtml(code, { lang: "rust", theme: "vesper" });
  } catch {
    return null;
  }
}
