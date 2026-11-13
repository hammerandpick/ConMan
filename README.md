# ConMan

ConMan, short form of ConnectionManager, is a small PHP signaling service and browser app for connecting a computer and phones or other devices. A room code pairs up to six browsers in a peer-to-peer mesh; WebRTC carries messages, audio, and video directly between each pair. The PHP server only relays the connection setup messages.

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
3. Scan the QR code to open ConMan and join automatically, or enter the code manually. Once connected, messages and enabled media are sent directly to the other devices in the room.
4. Open **Room menu** to view the QR invite and room ID, copy either, or leave. If the room creator leaves, the room closes for everyone.

Rooms admit up to six devices. Every pair of devices creates its own WebRTC connection, so each device maintains at most five peer connections. Microphone and camera are off until enabled; the browser asks for permission when you turn one on. Audio from other devices starts muted and can be unmuted individually in the device list. Enabling or disabling media renegotiates the affected peer connections so each device can send and receive independently. Room codes expire after two hours without activity; devices that stop polling are removed after five minutes. Messages and media travel through encrypted peer-to-peer connections and are not stored by the PHP service; signaling metadata is temporarily stored in `storage/rooms`. This mesh is intended for small groups: bandwidth and connection load increase as devices join.

The QR code is generated in the browser and contains the room invite URL; it is not sent to an external QR service. The phone must be able to reach the same web-server address. A URL using `localhost` only works on the computer itself, so open ConMan through a network-accessible hostname/IP or HTTPS URL before scanning. HTTPS is recommended for mobile browsers and required for future microphone/camera access.

The room workspace separates the device list, main table, and chat into responsive layout layers. The main table can show active video and provides an image/content area for future room features; the room menu remains a separate overlay.

The app uses a public STUN server for direct connection setup. Some networks block direct peer-to-peer traffic; production deployments that need broader network compatibility should configure a TURN relay and restrict its credentials and usage. Serve the app over HTTPS and apply normal web-server rate limits and disk quotas before exposing it publicly.
