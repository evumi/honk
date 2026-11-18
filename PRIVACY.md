# Honk Push Privacy Policy

Last updated: November 17, 2026

Honk Push is a notification utility published by Le He. This policy describes the iOS app and the default Honk gateway at https://honk.bunship.site. If you select a gateway operated by someone else, that operator controls the data it receives; review its privacy practices separately.

## Information used to deliver notifications

- Device information: the gateway stores a randomly assigned device identifier, platform, Apple (or Firebase) push notification token, a hash of the device authentication secret, the device name or model the app reports (for example "iPhone 15", shown in your device list), and the time of the device's last request (updated at most once an hour). These associate your bots and queued messages with your installation.
- Device groups: devices you pair (to switch phones or use several) belong to one group with a random identifier, which owns the bots and the message queue. When you pair, the old device uploads a bundle of your bot tokens that is encrypted with a key derived from the pairing code; the gateway keeps it for ten minutes at most, until it is claimed once, and cannot read it because it never sees the code. The pairing code is not stored on the gateway; only a value derived from it is, in hashed form.
- Bot settings: the gateway stores bot identifiers, names, avatar references, notification preferences, and hashed bot credentials.
- Notification content: services you authorize with a bot token send message titles, bodies, HTML cards, card data, links, and related message metadata to the gateway. This content is stored temporarily so your device can retrieve it.
- Operational information: network requests expose an IP address to the gateway and hosting infrastructure. The gateway uses IP addresses for registration rate limits and records operational errors and push-delivery failures for troubleshooting.

These data are used to provide, secure, and troubleshoot the notification service. Notification content and bot settings are associated with your device group, which each of your devices belongs to. Honk Push does not require a name, email address, or phone number to use the app.

## Data on your device

Message history and preferences are stored locally. Device credentials and bot encryption keys are stored using Apple's Keychain. A photo selected as a bot avatar is saved on the device; the app sends only its local filename reference to the gateway, not the selected photo. The app does not upload your photo library or contacts.

## Notification delivery and other services

Apple Push Notification service processes the device push token and notification payload, including the notification title/body and message identifiers. The device retrieves the HTML card and other details from your gateway. Infrastructure providers process network traffic and stored data as needed to operate the gateway.

If you select a gateway that has no push credentials of its own, for example a self-hosted one, that gateway sends each push through a push relay, by default the Honk gateway at https://honk.bunship.site (the operator can change or switch this off). The relay receives the push token, platform, message identifier, bot identifier, notification level, a hashed collapse key, and the gateway's IP address and request time. By default a relayed push contains no bot name, title or body; the device fetches those from its own gateway, and until then the banner reads "New notification". A gateway operator can choose to include the bot name, title and body in relayed pushes. The relay does not store pushes: it keeps only a registry of the gateways it relays for (identifier, a hash of its key, timestamps, whether it is blocked) and in-memory rate-limit counters, and does not log push tokens.

Honk Push does not include advertising or cross-app tracking features. Data is not sold or used for advertising profiling.

The default gateway uses HTTPS. By default, messages are not end-to-end encrypted: the gateway operator can access queued message content, and Apple and Google process the notification payload. For each bot you can turn on end-to-end encryption in the app: the app generates a key that stays on your devices (in the Keychain or Android Keystore-backed storage) and is never sent to the gateway, and the sender encrypts the message content with it. The gateway then stores and forwards only ciphertext and refuses that bot's plaintext messages, and its pushes carry no title, body or bot name, so the gateway operator, a push relay, Apple and Google cannot read the content. Encryption does not hide the metadata the gateway needs to deliver a message: which bot receives it, when, its approximate size, and its level, group and replace id. It does not protect against a compromised sender (which holds the key) or a compromised device. A message the device cannot decrypt is shown as "Couldn't decrypt this notification". Keep device secrets, bot tokens and encryption keys private. A party holding a bot token can send notifications to that bot; with end-to-end encryption on, sending also needs the key.

Opening a link in a notification or loading a configured remote avatar may contact the relevant website. That site's own privacy practices apply.

## Retention and deletion

The gateway's default configuration expires queued messages after seven days and removes messages that every device of your group has acknowledged about one day after they were created, during periodic cleanup. A device whose push token the push service has rejected and that has made no request for 90 days is deleted automatically, together with the group's bots and queued messages when it was the group's last device. Self-hosted operators can change these intervals. Device records and bot settings remain until deleted. Local history is separate from the temporary gateway queue.

You can delete a bot from the app to remove that bot and its queued messages. In Settings you can remove a device from your device group (the other devices and the bots stay), either another device from the list or "Remove this device from the group" for the phone in your hand. You can also delete everything the gateway holds for you: Settings, "Delete all data". The app asks the gateway to delete every device registration of the group, all its bots (their tokens stop working immediately) and the queued messages (DELETE /v1/devices/me?all=true), and only when the gateway confirms does it clear the messages, avatars, bot tokens, device credentials and notifications stored on the phone. If the gateway cannot be reached, nothing is deleted and the app says so; try again later. The device registers again only when you next create a bot or reopen the app. Deleting a local message or uninstalling the app does not by itself necessarily remove the gateway registration. Notification permissions can be changed in iOS Settings.

Operational logs and hosting backups, where present, are separate from the live message queue and follow the infrastructure operator's retention practices.

## Your choices and contact

You may choose a self-hosted gateway in the app, revoke a bot token, delete a bot, delete all data, or disable notifications. For privacy questions or assistance with deletion on the default gateway, contact the maintainer through https://github.com/evumi/honk/issues. Do not post device secrets, bot tokens, notification contents, or other private information in a public issue; ask for a private follow-up channel.

This policy may be updated when the service changes. The date above identifies the current version.
