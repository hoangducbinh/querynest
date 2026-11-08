import { isTauri } from "../postgres/client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  X,
  Database,
  ChevronRight,
  CheckCircle2,
  AlertCircle,
  LoaderCircle,
  Plug,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { pgError } from "../postgres/model";
import { testRemoteConnection } from "./client";
import {
  connectionEngines,
  defaultRemoteConfig,
  engineName,
  parseRemoteConfig,
  type RemoteConfig,
} from "./model";
export function ConnectionDialog({
  initial,
  initialName = "",
  profileMode = false,
  allowEngineChange = false,
  onConnect,
  onClose,
}: {
  initial: RemoteConfig;
  initialName?: string;
  profileMode?: boolean;
  allowEngineChange?: boolean;
  onConnect: (
    value: RemoteConfig,
    password: string,
    name: string,
  ) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [name, setName] = useState(initialName);
  const [port, setPort] = useState(String(initial.config.port));
  const [password, setPassword] = useState("");
  const [action, setAction] = useState<"test" | "connect" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const busy = action !== null;
  const config = value.config;
  const windowsAuth =
    value.engine === "mssql" && value.config.auth === "windows";
  function update(patch: Partial<RemoteConfig["config"]>) {
    setValue(
      (current) =>
        ({
          ...current,
          config: { ...current.config, ...patch },
        }) as RemoteConfig,
    );
  }
  const parsed = () =>
    parseRemoteConfig({
      ...value,
      config: { ...config, port: Number(port) },
    } as RemoteConfig);
  async function submit(test: boolean) {
    if (busy) return;
    setError("");
    setSuccess("");
    setAction(test ? "test" : "connect");
    try {
      if (test) {
        const result = await testRemoteConnection(parsed(), password);
        setSuccess(
          `Connected · ${engineName(value.engine)} ${result.serverVersion}`,
        );
      } else {
        await onConnect(
          parsed(),
          password,
          name.trim() || `${config.database} · ${engineName(value.engine)}`,
        );
        setPassword("");
        onClose();
      }
    } catch (error) {
      setError(pgError(error));
    } finally {
      setAction(null);
    }
  }
  const securityLabel =
    value.engine === "postgres"
      ? value.config.sslMode === "verify-full"
        ? "Verified SSL"
        : value.config.sslMode === "require"
          ? "Encrypted SSL"
          : "SSL off"
      : value.config.encrypt
        ? value.config.trustCertificate
          ? "TLS · verification off"
          : "Verified TLS"
        : "TLS off";
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal pg-connection-dialog"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className="connection-dialog-heading">
            <span className="connection-dialog-icon">
              <Database size={19} />
            </span>
            <div>
              <Dialog.Title>
                {profileMode
                  ? "Connection settings"
                  : allowEngineChange
                    ? "New connection"
                    : `Connect to ${engineName(value.engine)}`}
              </Dialog.Title>
              <Dialog.Description>
                {profileMode
                  ? "Saved settings apply the next time you connect."
                  : "One connection for SQL and Data."}
              </Dialog.Description>
            </div>
            <Button
              className="connection-close"
              title="Close connection settings"
              aria-label="Close connection settings"
              disabled={busy}
              onClick={onClose}
            >
              <X size={15} />
            </Button>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(false);
            }}
          >
            <fieldset
              className="connection-fields"
              disabled={busy}
              onChange={() => {
                setError("");
                setSuccess("");
              }}
            >
              {allowEngineChange && (
                <label>
                  Database type
                  <select
                    value={value.engine}
                    onChange={(event) => {
                      const engine = connectionEngines.find(
                        (option) => option.id === event.target.value,
                      )?.id;
                      if (!engine || engine === value.engine) return;
                      const next = defaultRemoteConfig(engine);
                      setValue(next);
                      setPort(String(next.config.port));
                      setPassword("");
                      setError("");
                      setSuccess("");
                    }}
                  >
                    {connectionEngines.map((engine) => (
                      <option key={engine.id} value={engine.id}>
                        {engine.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {(profileMode || allowEngineChange) && (
                <label
                  className={
                    allowEngineChange ? undefined : "connection-full-width"
                  }
                >
                  Connection name
                  <input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={`${config.database} · ${engineName(value.engine)}`}
                    maxLength={100}
                  />
                </label>
              )}
              <div className="pg-form-row">
                <label>
                  Host
                  <input
                    autoFocus={!profileMode && !allowEngineChange}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    value={config.host}
                    onChange={(event) => update({ host: event.target.value })}
                    placeholder="localhost or server IP"
                  />
                </label>
                <label>
                  Port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                  />
                </label>
              </div>
              <label
                className={
                  value.engine === "postgres"
                    ? "connection-full-width"
                    : undefined
                }
              >
                Database
                <input
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={config.database}
                  onChange={(event) => update({ database: event.target.value })}
                />
              </label>
              {value.engine === "mssql" && (
                <label>
                  Authentication
                  <select
                    value={value.config.auth || "sql"}
                    onChange={(event) =>
                      update({ auth: event.target.value as "sql" | "windows" })
                    }
                  >
                    <option value="sql">SQL Server login</option>
                    <option value="windows">Windows · current account</option>
                  </select>
                </label>
              )}
              {!windowsAuth && (
                <div className="connection-credentials">
                  <label>
                    {value.engine === "mssql" ? "SQL login" : "User"}
                    <input
                      autoComplete="off"
                      autoCapitalize="none"
                      spellCheck={false}
                      value={config.user}
                      onChange={(event) => update({ user: event.target.value })}
                    />
                  </label>
                  <label>
                    <span>
                      Password{profileMode && <small> · test only</small>}
                    </span>
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                    />
                  </label>
                </div>
              )}
              {windowsAuth && (
                <p className="connection-inline-hint">
                  Uses the current account in the Windows app.
                </p>
              )}
              <label className="connection-readonly">
                <span>
                  <strong>
                    {value.engine === "mssql"
                      ? "Query-only guard"
                      : "Read-only connection"}
                  </strong>
                  <small>
                    {value.engine === "mssql"
                      ? "Block write statements in this app."
                      : "Prevent changes to database data."}
                  </small>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={
                    value.engine === "mssql"
                      ? "Query-only guard"
                      : "Read-only connection"
                  }
                  checked={config.readOnly}
                  onChange={(event) =>
                    update({ readOnly: event.target.checked })
                  }
                />
              </label>
              <details className="connection-security">
                <summary>
                  <ChevronRight size={13} />
                  <span>Security</span>
                  <small>{securityLabel}</small>
                </summary>
                <div className="connection-security-fields">
                  {value.engine === "postgres" ? (
                    <label>
                      SSL
                      <select
                        value={value.config.sslMode}
                        onChange={(event) =>
                          update({
                            sslMode: event.target.value as
                              "verify-full" | "require" | "disable",
                          })
                        }
                      >
                        <option value="verify-full">
                          Verify certificate and hostname
                        </option>
                        <option value="require">
                          Encryption only (no certificate check)
                        </option>
                        <option value="disable">
                          Disabled — local connection
                        </option>
                      </select>
                    </label>
                  ) : (
                    <>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={value.config.encrypt}
                          onChange={(event) =>
                            update({ encrypt: event.target.checked })
                          }
                        />
                        Encrypt connection
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={value.config.trustCertificate}
                          disabled={!value.config.encrypt}
                          onChange={(event) =>
                            update({ trustCertificate: event.target.checked })
                          }
                        />
                        Trust server certificate{" "}
                        <span className="connection-inline-hint">
                          Local / self-signed
                        </span>
                      </label>
                    </>
                  )}
                </div>
              </details>
            </fieldset>
            {error && (
              <div role="alert" className="connection-feedback is-error">
                <AlertCircle size={14} />
                <span>{error}</span>
              </div>
            )}
            {success && (
              <div role="status" className="connection-feedback is-success">
                <CheckCircle2 size={14} />
                <span>{success}</span>
              </div>
            )}
            <div className="pg-dialog-actions">
              <Button
                className={`connection-test ${action === "test" ? "is-loading" : ""}`}
                disabled={busy || !isTauri()}
                title={!isTauri() ? "Test in the desktop app" : undefined}
                onClick={() => void submit(true)}
              >
                {action === "test" ? (
                  <LoaderCircle className="spin shrink-0" size={13} />
                ) : (
                  <Plug size={13} className="shrink-0" />
                )}
                <span>{action === "test" ? "Testing…" : "Test connection"}</span>
              </Button>
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                className={`primary ${action === "connect" ? "is-loading" : ""}`}
                type="submit"
                disabled={busy}
              >
                {action === "connect" && (
                  <LoaderCircle className="spin shrink-0" size={13} />
                )}
                <span>
                  {action === "connect"
                    ? profileMode
                      ? "Saving…"
                      : "Connecting…"
                    : profileMode
                      ? "Save connection"
                      : "Connect"}
                </span>
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
