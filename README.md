# Board Console

A self-hosted web admin panel for single-board computers. It runs on your PC and manages each board over SSH, so nothing has to be installed on the boards. It was built for a Raspberry Pi and a Radxa Rock 5B, and works with other Debian-style Linux boards that use systemd.

## Features

- **All boards:** live CPU, memory, temperature, disk and uptime, side by side
- **Console:** full terminals in the browser, with several boards open at once
- **Services:** start, stop, restart, enable and disable systemd services
- **Docker:** container status, logs, start, stop and restart (hidden on boards without Docker)
- **Processes:** search processes and stop or kill them
- **Logs:** journal viewer with service and severity filters and a follow mode
- **Files:** browse, download and upload (works without an SFTP server, so Dropbear is fine)
- **Updates:** list upgradable packages and start an upgrade in a terminal
- **Power:** reboot or shut down, with a typed confirmation

## Requirements

- Node.js 20 or newer
- SSH key login to each board, using an unencrypted key file. Passphrase-protected keys and ssh-agent are not supported yet.
- Each board's host key already in `~/.ssh/known_hosts`. Connect once with `ssh` to add it.
- A login that can manage the board directly, normally `root`. Commands do not use `sudo`.

## Setup

```bash
npm install
```

Copy `config/hosts.example.json` to `config/hosts.json` and edit it for your boards:

| Field | Meaning |
|---|---|
| `id` | Short name used in URLs, and typed to confirm a reboot or shutdown |
| `name` | Name shown in the panel |
| `host` | Hostname or IP address. It must match the entry in `known_hosts` exactly. |
| `port` | SSH port, 22 if omitted |
| `user` | SSH user |
| `key` | Path to the private key. `~` is expanded. |

```bash
npm start
```

Open <http://127.0.0.1:8088>. The first run prints a generated password once. To replace it:

```bash
npm run reset-password
```

If Windows PowerShell says running scripts is disabled, use `npm.cmd` in place of `npm`, or run `node src/server.js` and `node src/server.js --reset-password` directly.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `CONSOLE_HOST` | `127.0.0.1` | Address to listen on |
| `CONSOLE_PORT` | `8088` | Port to listen on |
| `CONSOLE_DATA_DIR` | `./data` | Where the password hash and audit log are stored |
| `CONSOLE_ALLOWED_HOSTS` | none | Extra comma-separated hostnames allowed in the `Host` header |

## Security

This panel gives anyone signed in to it the full access of its SSH users, usually root on every board. Treat its password like a root password.

- It listens only on this PC by default. The panel has no TLS of its own, so anyone on the network could read your traffic if you expose it directly. Use a VPN or an HTTPS reverse proxy for remote access.
- Passwords are hashed with scrypt, and repeated failed logins are locked out for a minute.
- Cookies are `HttpOnly` and `SameSite=Strict`. The server also checks `Host` and `Origin` on state-changing requests and terminal connections, which guards against cross-site attacks and DNS rebinding.
- Host keys are checked against `known_hosts`, and connections fail if a key is unknown or has changed.
- Admin actions are written to `data/audit.log`. Terminal keystrokes are not logged.
- Stopping or disabling the SSH service from the Services page is refused, because it would cut off the panel.

`config/hosts.json` and `data/` are git-ignored so your addresses, password hash and audit log stay out of the repository.

## Limitations

- Sessions are kept in memory, so restarting the server signs you out and closes terminals.
- The Updates page reads the board's cached package lists. Run **Check in terminal** to refresh them.
- Process CPU figures come from `ps`, which averages over each process's lifetime rather than showing current load.

## License

[MIT](LICENSE)
