# Messages for Linux (`apps/desktop`)

A native desktop client for the message hub, written in C++ and Qt Quick. It talks to the same hub API as the web app
and uses the MacShell look.

## What it does

- Inbox, merged iMessage / SMS / WhatsApp conversations, photos and files, replies, tapbacks, search.
- Sending text and files (the **+** button opens the desktop's file picker; you can also drop files into a chat),
  choosing the service when a person has more than one chat, replying (right-click a message).
- Live updates over the hub's WebSocket and desktop notifications for new messages. Clicking one opens the chat.
- **Follows MacShell's theme while it runs**: dark/light mode, accent colour, the Open Runde font and the 24-hour
  clock are read from `~/.config/macdock/settings.json` and `~/.config/macbar/settings.json`. The window, traffic lights and
  colours match MacShell's own app windows. Without MacShell it follows the desktop's dark/light setting.

## MacShell's Dynamic Island

With MacShell's Dynamic Island turned on, messages also show in the island:

- A new message briefly opens the island: sender, text and a **Reply** button. Clicking the banner opens the chat here.
- Chats with new messages take a slot in the island (with a count) until you've looked at them. Older unread mail
  doesn't count.
- Hovering that slot, or `qs -c MacShell ipc call island messages`, opens a card with the recent chats. Click one to
  type a reply right in the island (Enter sends, Esc cancels). The arrow (or a double-click) opens it in this app.
- Nothing pops up while the Messages window is focused or MacShell's Do Not Disturb is on.

The island talks to this app over its local socket (it sends `island`, then gets JSON lines; see
`App::addIslandClient` in `src/main.cpp`), so it uses the app's session and live feed and needs no login of its own.
If the app isn't running when MacShell starts, the island starts it in the background once. While the island is
connected, the app sends no desktop notifications of its own, so each message is announced once.
The island side lives in MacShell's `DynamicIsland.qml` (marked `[msgisland]`).

## Fast and small by design

- The QML is compiled to C++ at build time, and the UI uses only core Qt Quick items (no Controls style). Clicking the
  icon shows the window in about 0.1 s.
- The inbox and the latest page of each chat you open are cached on disk, so they appear at once. The hub's own reply
  replaces them when it arrives.
- Photos are downloaded once into `~/.cache/message-hub` and decoded on a worker thread at the size they are shown,
  never at full resolution.
- Closing the window doesn't quit. The app restarts itself in background mode (about 12 MB of its own memory) so live
  updates and notifications keep working, and reopening is just as quick. **Ctrl+Q** (or *Quit Messages* in the
  launcher's menu) quits for real.
- One instance only: launching it again brings the window up.

Measured on this laptop: about 42 MB PSS in the background (12 MB private; the rest is shared Qt libraries) and
about 120 MB with the window open (most of that is the GPU driver).

## Build and install

Needs Qt 6.5 or newer (Quick, Network, WebSockets, DBus, ShaderTools), CMake and a C++20 compiler.
On Arch: `pacman -S qt6-declarative qt6-websockets qt6-shadertools cmake ninja`.

```sh
cd apps/desktop
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=$HOME/.local
cmake --build build
cmake --install build
```

This installs `~/.local/bin/message-hub`, the *Messages* launcher entry and its icon. Sign in with the hub's address
(for example `https://messages.example.com`) and the hub's password. The session is kept in
`~/.config/message-hub/config.json`, readable only by you.

To keep notifications coming after login, start it in the background with your session, e.g. in Hyprland:
`hl.exec_cmd("message-hub --background")` (Lua config) or `exec-once = message-hub --background`.

## Keys

| Key | Action |
|---|---|
| Ctrl+F / Ctrl+K | Search conversations and messages |
| Alt+Up / Alt+Down, Ctrl+Tab | Previous / next conversation |
| Enter / Shift+Enter | Send / new line |
| Ctrl+R | Refresh |
| Ctrl+W | Close the window (keeps running for notifications) |
| Ctrl+Q | Quit |

## Command line

`message-hub` shows the window, `--background` starts without one, `--open <thread id>` opens a chat
(e.g. `p12` or `c40`), `--quit` stops the running instance.

For development, with `MESSAGE_HUB_DEV=1` set on the running instance, `message-hub --dev "<command>"` drives it:
`grab <file.png>`, `send <text>`, `filter <text>`, `older`, `top`, `list`, `close`, `login <server> <password>`,
`logout`. `QT_QPA_PLATFORM=offscreen` runs it without a window, and `MESSAGE_HUB_SOCKET` and `XDG_CONFIG_HOME` /
`XDG_CACHE_HOME` keep a test instance apart from your real one.

## Layout

| Path | What it is |
|---|---|
| `src/hub.*` | Hub API client: sign-in, inbox, open chat, sending, search, live socket, attachments, notifications, file picker (XDG portal) |
| `src/theme.*` | Reads and watches the MacShell settings |
| `src/listmodel.*` | List model that applies minimal changes, so lists keep their scroll position and recycle rows |
| `src/main.cpp` | Single instance, window lifecycle (restart into background mode), attachment image provider |
| `qml/` | The UI |
| `shaders/roundedimage.frag` | Rounded corners for photos without an offscreen layer |
