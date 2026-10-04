---
title: Secrets für Plugins
summary: Schlüssel und Adressen, die Plugins nutzen, ohne sie je zu sehen.
---
Secrets liegen unter **Einstellungen → API / Secrets** (Benutzermenü).

## So funktioniert es

1. Beim Installieren legt ein Plugin seine Secrets leer an, z. B. `PLEX_URL` und `PLEX_TOKEN`.
2. Du trägst den Wert ein und schaltest das Secret **für das Plugin frei**.
3. Wenn das Plugin seinen Dienst aufruft, nennt es das Secret. Der Bot setzt den Wert in die Anfrage ein und maskiert ihn in der Antwort. Der Code des Plugins sieht ihn nie.

## Gut zu wissen

- Secrets gehören einem Benutzer. Ein Bot nutzt die Secrets seines Besitzers.
- **Adressen** (`…_URL`) dürfen in deinem Heimnetz liegen. **Schlüssel** gehen nur an die Hosts, die das Plugin angegeben hat.
- Ein Secret, ohne das ein Plugin auskommt (z. B. Overseerr bei Plex, der Login bei Forge), bleibt aus, wenn du es nicht nutzt.
- Manche Dienste haben stattdessen einen **Anmelden**-Button (z. B. *Mit Plex anmelden*), der die Secrets für dich ausfüllt.
