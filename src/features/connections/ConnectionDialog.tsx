import { isTauri } from "../postgres/client";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { pgError } from "../postgres/model";
import { testRemoteConnection } from "./client";
import { engineName, parseRemoteConfig, type RemoteConfig } from "./model";
export function ConnectionDialog({
  initial,
  initialName = "",
  profileMode = false,
  onConnect,
  onClose,
}: {
  initial: RemoteConfig;
  initialName?: string;
  profileMode?: boolean;
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
    setError("");
    setSuccess("");
    setAction(test ? "test" : "connect");
    try {
      if (test) {
        const result = await testRemoteConnection(parsed(), password);
        setSuccess(
          `Connection successful · ${engineName(value.engine)} ${result.serverVersion}`,
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
          onEscapeKeyDown={(e) => {
            if (busy) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <div className="row">
            <Dialog.Title>
              {profileMode
                ? "Connection settings"
                : `Connect to ${engineName(value.engine)}`}
            </Dialog.Title>
            <Button
              title="Close connection settings"
              disabled={busy}
              onClick={onClose}
            >
              <X size={15} />
            </Button>
          </div>
          <Dialog.Description>
            {profileMode
              ? "Save a reusable connection. Passwords are never saved."
              : "Passwords are never saved. Connections stay available while switching workspaces; inactive sessions expire after 30 minutes."}
          </Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit(false);
            }}
          >
            <fieldset
              disabled={busy}
              onChange={() => {
                setError("");
                setSuccess("");
              }}
            >
              {profileMode && (
                <label>
                  Connection name
                  <input
                    autoFocus
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={`${config.database} · ${engineName(value.engine)}`}
                    maxLength={100}
                  />
                </label>
              )}
              <div className="pg-form-row">
                <label>
                  Host
                  <input
                    autoFocus={!profileMode}
                    autoComplete="off"
                    value={config.host}
                    onChange={(e) => update({ host: e.target.value })}
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
                    onChange={(e) => setPort(e.target.value)}
                  />
                </label>
              </div>
              <label>
                Database
                <input
                  autoComplete="off"
                  value={config.database}
                  onChange={(e) => update({ database: e.target.value })}
                />
              </label>
              {value.engine === "mssql" && (
                <label>
                  Authentication
                  <select
                    value={value.config.auth || "sql"}
                    onChange={(e) =>
                      update({ auth: e.target.value as "sql" | "windows" })
                    }
                  >
                    <option value="sql">SQL Server login</option>
                    <option value="windows">Windows · current account</option>
                  </select>
                </label>
              )}
              {!(
                value.engine === "mssql" && value.config.auth === "windows"
              ) && (
                <>
                  <label>
                    {value.engine === "mssql" ? "SQL login" : "User"}
                    <input
                      autoComplete="off"
                      value={config.user}
                      onChange={(e) => update({ user: e.target.value })}
                    />
                  </label>
                  <label>
                    Password{profileMode && " (for testing only)"}
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                </>
              )}
              {value.engine === "postgres" ? (
                <label>
                  SSL
                  <select
                    value={value.config.sslMode}
                    onChange={(e) =>
                      update({
                        sslMode: e.target.value as
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
                    <option value="disable">Disabled — local connection</option>
                  </select>
                </label>
              ) : (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={value.config.encrypt}
                      onChange={(e) => update({ encrypt: e.target.checked })}
                    />
                    Encrypt connection
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={value.config.trustCertificate}
                      disabled={!value.config.encrypt}
                      onChange={(e) =>
                        update({ trustCertificate: e.target.checked })
                      }
                    />
                    Trust server certificate (local/self-signed)
                  </label>
                </>
              )}
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={config.readOnly}
                  onChange={(e) => update({ readOnly: e.target.checked })}
                />
                {value.engine === "mssql"
                  ? "Query-only guard"
                  : "Read-only connection"}
              </label>
              {value.engine === "mssql" && (
                <p className="connection-hint">
                  TCP port required. Windows authentication uses your current
                  account in the Windows app. Query-only blocks write
                  statements; use a database account with read-only permissions
                  for enforced protection.
                </p>
              )}
            </fieldset>
            {error && (
              <p role="alert" className="pg-error">
                {error}
              </p>
            )}
            {success && (
              <p role="status" className="connection-success">
                {success}
              </p>
            )}
            <div className="pg-dialog-actions">
              <Button
                disabled={busy || !isTauri()}
                title={!isTauri() ? "Test in the desktop app" : undefined}
                onClick={() => void submit(true)}
              >
                {action === "test" ? "Testing…" : "Test connection"}
              </Button>
              <Button disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button className="primary" type="submit" disabled={busy}>
                {action === "connect"
                  ? profileMode
                    ? "Saving…"
                    : "Connecting…"
                  : profileMode
                    ? "Save connection"
                    : "Connect"}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
