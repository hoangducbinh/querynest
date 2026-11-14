import { RotateCw } from "lucide-react";
import { createPortal } from "react-dom";
import { Channel, invoke } from "@tauri-apps/api/core";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { bindMacTerminalInput } from "./terminal-mac-input";
import { Button } from "../../components/ui/button";

function terminalTheme(node: HTMLElement) {
  const { backgroundColor, color } = getComputedStyle(node);
  const dark = node.closest(".app")?.classList.contains("dark");
  return {
    background: backgroundColor,
    foreground: color,
    cursor: color,
    selectionBackground: dark ? "#507eb675" : "#527fc45c",
    black: dark ? "#161b24" : "#242933",
    red: dark ? "#ff858a" : "#a82539",
    green: dark ? "#9bd48b" : "#22683e",
    yellow: dark ? "#e9c47e" : "#805700",
    blue: dark ? "#8eafff" : "#2557a7",
    magenta: dark ? "#d9a1ef" : "#873d9c",
    cyan: dark ? "#84d5df" : "#006d7b",
    white: dark ? "#d6dce6" : "#454e60",
    brightBlack: dark ? "#919caf" : "#5e697a",
    brightWhite: color,
  };
}

export default function SystemTerminal({
  visible,
  toolbarHost,
  panelExpanded,
}: {
  visible: boolean;
  toolbarHost: HTMLElement | null;
  panelExpanded?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [session, setSession] = useState({ profile: "", attempt: 0 });
  const [profile, setProfile] = useState("");
  const [profiles, setProfiles] = useState<{ id: string; label: string }[]>([]);
  useEffect(() => {
    let active = true;
    void invoke<typeof profiles>("terminal_profiles").then((items) => {
      if (active) setProfiles(items);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  const [status, setStatus] = useState("Starting terminal…");
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const terminal = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Consolas, monospace',
      fontSize: 13,
      cursorStyle: "bar",
      cursorWidth: 1,
      cursorInactiveStyle: "none",
      cursorBlink: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      scrollback: 3000,
      minimumContrastRatio: 4.5,
      lineHeight: 1.12,
      theme: terminalTheme(node),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(node);
    const unbindMacInput = bindMacTerminalInput(terminal);
    if (node.clientWidth && node.clientHeight) fit.fit();

    let disposed = false;
    let ended = false;
    let id: string | undefined;
    let pendingInput = "";
    let writingInput = false;
    function finish(message: string) {
      if (disposed || ended) return;
      ended = true;
      setClosed(true);
      setStatus(message);
      if (id) void invoke("terminal_close", { id }).catch(() => {});
    }

    const output = new Channel<ArrayBuffer>();
    output.onmessage = (data) => {
      if (disposed || ended) return;
      if (!data.byteLength) finish("Terminal exited.");
      else terminal.write(new Uint8Array(data));
    };
    async function flushInput(sessionId: string) {
      writingInput = true;
      try {
        while (pendingInput && !disposed && !ended) {
          // Send the first edit immediately and combine edits queued during IPC.
          const text = pendingInput;
          pendingInput = "";
          await invoke("terminal_write", { id: sessionId, input: text });
        }
      } catch (error) {
        finish(String(error));
      } finally {
        writingInput = false;
      }
    }

    const input = terminal.onData((text) => {
      if (!id || disposed || ended) return;
      pendingInput += text;
      if (!writingInput) void flushInput(id);
    });
    const resize = terminal.onResize(({ cols, rows }) => {
      if (id && !ended) {
        void invoke("terminal_resize", { id, cols, rows }).catch(() => {});
      }
    });
    const observer = new ResizeObserver(() => {
      if (node.clientWidth && node.clientHeight) fit.fit();
    });
    observer.observe(node);
    const app = node.closest(".app");
    let dark = app?.classList.contains("dark");
    const themeObserver = new MutationObserver(() => {
      const nextDark = app?.classList.contains("dark");
      if (nextDark !== dark) {
        dark = nextDark;
        terminal.options.theme = terminalTheme(node);
      }
    });
    if (app) themeObserver.observe(app, { attributes: true, attributeFilter: ["class"] });
    terminalRef.current = terminal;

    void invoke<string>("terminal_open", {
      cols: terminal.cols,
      rows: terminal.rows,
      output,
      profile: session.profile || null,
    }).then((sessionId) => {
      if (disposed || ended) {
        void invoke("terminal_close", { id: sessionId }).catch(() => {});
        return;
      }
      id = sessionId;
      setStatus("");
      if (node.clientWidth && node.clientHeight) {
        void invoke("terminal_resize", { id, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
      }
    }, (error) => finish(String(error)));

    return () => {
      disposed = true;
      terminalRef.current = null;
      observer.disconnect();
      themeObserver.disconnect();
      input.dispose();
      resize.dispose();
      unbindMacInput();
      terminal.dispose();
      if (id) void invoke("terminal_close", { id }).catch(() => {});
    };
  }, [session]);

  useEffect(() => {
    if (visible && !closed && !status) terminalRef.current?.focus();
  }, [visible, closed, status, panelExpanded]);

  function restartTerminal() {
    setClosed(false);
    setStatus("Starting terminal…");
    setSession((previous) => ({ profile, attempt: previous.attempt + 1 }));
  }

  return (
    <div className="system-terminal" hidden={!visible} role="tabpanel" aria-label="Terminal">
      {status && (
        <div className="system-terminal-status">
          <span role="status">{status}</span>
        </div>
      )}
      <div className="system-terminal-screen" ref={host} />
      {visible && toolbarHost && createPortal(
        <div className="system-terminal-tools">
          <select
            aria-label="Terminal shell"
            value={profile}
            onChange={(event) => setProfile(event.target.value)}
          >
            <option value="">System default</option>
            {profiles.map(({ id, label }) => <option key={id} value={id}>{label}</option>)}
          </select>
          {(closed || (!status && profile !== session.profile)) && (
            <Button title="Restart with selected shell" onClick={restartTerminal}>
              <RotateCw size={12} aria-hidden="true" />
            </Button>
          )}
        </div>,
        toolbarHost,
      )}

    </div>
  );
}
