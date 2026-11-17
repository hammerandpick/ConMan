# ConMan

ConMan, short form of ConnectionManager, is a small PHP signaling service and browser app for connecting a computer and phones or other devices. A room code pairs up to six browsers in a peer-to-peer mesh; WebRTC carries audio and video directly between each pair, and an optional Server device can relay room chat. The PHP server only relays connection setup messages.

## Requirements

- PHP 8.1 or later, with JSON support and permission to create/write files under `storage/rooms`.
- An HTTPS web server with PHP enabled for use from other devices. Browsers require a secure context for WebRTC and clipboard access; `localhost` is also allowed for local testing.
- Current browsers with WebRTC support.

## Run locally

From this directory, serve the files with your PHP-enabled web server. For local-only development with PHP CLI installed:

```text
php -S 127.0.0.1:8000
```

Open `http://127.0.0.1:8000` on the computer. To test a phone, deploy behind HTTPS and open the same site there. Make sure the web-server account can write to `storage/rooms`. The storage folder has deny rules for IIS and Apache; retain equivalent access controls if using another server.

## Connect devices

1. Select **Create a room** on one device.
2. Share the displayed QR code or eight-character code with up to five other devices.
3. Scan the QR code to open ConMan and join automatically, or enter the code manually. Once connected, messages use the selected chat route and enabled media is sent directly to the other devices in the room.
4. Optionally, open **Room menu** and make one device the **Server**. That device relays room chat to the other devices; it must stay connected for chat relay to work. Only one device can be the Server at a time. With no Server selected, chat is sent directly between devices.
5. Open **Room menu** to view the QR invite and room ID, copy either, or leave. Explicitly closing the room as its creator closes it for everyone.

The room menu also lets any room member send shared JSON data. Submit one update or an array of updates, each shaped like `{"key":"status","timestamp":1730000000000,"value":{"ready":true}}`. The selected Server device merges updates; if no Server is selected, the lowest-numbered device coordinates the merge. If the coordinator is unreachable for 30 seconds, the next available higher-numbered device takes over (wrapping to the lowest available device if needed). Newer timestamps replace older values for the same key (equal timestamps keep the first accepted update). Updates and merged data travel over WebRTC data channels rather than being sent to the PHP service. Timestamps should be Unix milliseconds; values can be any JSON value. Shared data is limited to 64 KiB per room.

Each device automatically saves the current room data to its own browser storage every five minutes and after changes. These automatic saves are local to the device and room. Use the room menu to save additional snapshots, view saved data across rooms in that browser, import a snapshot into the current room, or export/import a JSON file. The **Show saved data** list is newest first. PHP stores signaling and room membership metadata, but not shared JSON data.

Rooms admit up to six devices. Every pair of devices creates its own WebRTC connection, so each device maintains at most five peer connections. Microphone and camera are off until enabled; the browser asks for permission when you turn one on. Audio from other devices starts muted and can be unmuted individually in the device list. Enabling or disabling media renegotiates the affected peer connections so each device can send and receive independently. Devices that stop polling are removed from the connection list, signaling events, and room metadata after five minutes; the room remains available until two hours of inactivity unless its creator explicitly closes it. Messages and media travel through encrypted peer-to-peer connections and are not stored by the PHP service; signaling metadata is temporarily stored in `storage/rooms`. This mesh is intended for small groups: bandwidth and connection load increase as devices join.

The QR code is generated in the browser and contains the room invite URL; it is not sent to an external QR service. The phone must be able to reach the same web-server address. A URL using `localhost` only works on the computer itself, so open ConMan through a network-accessible hostname/IP or HTTPS URL before scanning. HTTPS is recommended for mobile browsers and required for future microphone/camera access.

The room workspace separates the device list, main table, and chat into responsive layout layers. The main table can show active video and provides an image/content area for future room features; the room menu remains a separate overlay.

The app uses a public STUN server for direct connection setup. Some networks block direct peer-to-peer traffic; production deployments that need broader network compatibility should configure a TURN relay and restrict its credentials and usage. Serve the app over HTTPS and apply normal web-server rate limits and disk quotas before exposing it publicly.
