# Honk Push Privacy Policy

Last updated: November 17, 2026

Honk Push is a notification utility published by Le He. This policy describes the iOS app and the default Honk gateway at https://honk.bunship.site. If you select a gateway operated by someone else, that operator controls the data it receives; review its privacy practices separately.

## Information used to deliver notifications

- Device information: the gateway stores a randomly assigned device identifier, platform, Apple push notification token, and a hash of the device authentication secret. These associate your bots and queued messages with your installation.
- Bot settings: the gateway stores bot identifiers, names, avatar references, notification preferences, and hashed bot credentials.
- Notification content: services you authorize with a bot token send message titles, bodies, HTML cards, card data, links, and related message metadata to the gateway. This content is stored temporarily so your device can retrieve it.
- Operational information: network requests expose an IP address to the gateway and hosting infrastructure. The gateway uses IP addresses for registration rate limits and records operational errors and push-delivery failures for troubleshooting.

These data are used to provide, secure, and troubleshoot the notification service. Notification content and bot settings are associated with the device identifier. Honk Push does not require a name, email address, or phone number to use the app.

## Data on your device

Message history and preferences are stored locally. Device credentials are stored using Apple's Keychain. A photo selected as a bot avatar is saved on the device; the app sends only its local filename reference to the gateway, not the selected photo. The app does not upload your photo library or contacts.

## Notification delivery and other services

Apple Push Notification service processes the device push token and notification payload, including the notification title/body and message identifiers. The device retrieves the HTML card and other details from your gateway. Infrastructure providers process network traffic and stored data as needed to operate the gateway.

Honk Push does not include advertising or cross-app tracking features. Data is not sold or used for advertising profiling.

The default gateway uses HTTPS. Messages are not end-to-end encrypted: the gateway operator can access queued message content, and Apple processes the notification payload. Keep device secrets and bot tokens private. A party holding a bot token can send notifications to that bot.

Opening a link in a notification or loading a configured remote avatar may contact the relevant website. That site's own privacy practices apply.

## Retention and deletion

The gateway's default configuration expires queued messages after seven days and removes acknowledged messages after about one day, during periodic cleanup. Self-hosted operators can change these intervals. Device records and bot settings remain until deleted. Local history is separate from the temporary gateway queue.

You can delete a bot from the app to remove that bot and its queued messages. The authenticated gateway API also supports deleting the device registration and all associated bots and queued messages through DELETE /v1/devices/me. Deleting a local message or uninstalling the app does not by itself necessarily remove the gateway registration. Notification permissions can be changed in iOS Settings.

Operational logs and hosting backups, where present, are separate from the live message queue and follow the infrastructure operator's retention practices.

## Your choices and contact

You may choose a self-hosted gateway in the app, revoke a bot token, delete a bot, or disable notifications. For privacy questions or assistance with deletion on the default gateway, contact the maintainer through https://github.com/evumi/honk/issues. Do not post device secrets, bot tokens, notification contents, or other private information in a public issue; ask for a private follow-up channel.

This policy may be updated when the service changes. The date above identifies the current version.
