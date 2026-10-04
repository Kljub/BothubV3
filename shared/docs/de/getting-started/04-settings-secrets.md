---
title: Deine Einstellungen und API / Secrets
summary: Sprache, Design, Konto, Zwei-Faktor-Anmeldung und deine eigenen Schlüssel.
---
Öffne das **Benutzermenü** unten links und wähl **Einstellungen**.

## Allgemein

- **Sprache** des Dashboards (auch über den Globus oben rechts). Sie gilt nur für dich.
- **Design**: System, hell oder dunkel.

## Konto und Sicherheit

- Benutzername, E-Mail und Passwort.
- **Zwei-Faktor-Anmeldung** mit einer Authenticator-App, und Passkeys.

## API / Secrets

Plugins und manche Module brauchen Schlüssel oder Adressen: einen OpenAI-Key für AI Chat, Adresse und Token deines Plex-Servers, die Adresse deines Stable-Diffusion-Forge-Servers und so weiter. Das sind **Secrets**:

- Jeder Benutzer hat seine eigenen Secrets. Andere Benutzer sehen und nutzen sie nie.
- Ein Bot nutzt die Secrets **seines Besitzers**.
- Ein Plugin sieht ein Secret nie. Es nennt nur den Namen, und der Bot setzt den Wert in die Anfrage ein.
- Ein Secret nutzen nur Plugins, für die du es **freigeschaltet** hast (der Schalter neben dem Plugin).

Beim Installieren eines Plugins werden seine Secrets leer angelegt (*[NULL]*). Wert eintragen, für das Plugin freischalten, fertig. Ein Secret, das du nicht brauchst (ein optionales), lässt du einfach aus.

> [!TIP]
> Adressen dürfen in dein Heimnetz zeigen (z. B. `http://192.168.1.20:7860`), Schlüssel gehen nur an die Hosts, die das Plugin angegeben hat.

## Admin-Bereich

Benutzer mit Admin-Rechten finden im Benutzermenü auch den **Admin-Bereich**: Ressourcen-Übersicht, Benutzer und Rollen, Server-Logs, **SDK-Richtlinien** (was Plugins dürfen), Server-Einstellungen, Invite Policies, E-Mail und die Instanz-Secrets (z. B. den Token für den BotHub Marketplace).
