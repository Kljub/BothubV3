---
title: Bot verifizieren lassen
summary: Was Discords App-Verifizierung ab 75 Servern verlangt und wie BotHub hilft.
---
Ein Bot kann höchstens **100 Servern** beitreten, bis Discord ihn **verifiziert** hat. Beantragen kannst du das ab **75 Servern**. Verifizierte Bots bekommen das ✓-Abzeichen neben dem Namen.

![Der Weg zur verifizierten App: Team, Identität, App-Angaben, Intents, Absenden](/static/docs/verify-steps.svg)

> [!NOTE]
> Discord ändert die Details ab und zu. Die Checkliste im Tab **App Verification** deiner App zeigt immer, was noch fehlt; Discords eigene Anleitung: [How Do I Get My App Verified?](https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified)

## 1. Die App in ein Team legen

Öffne im [Developer Portal](https://discord.com/developers/applications) **Teams**, leg ein Team an und übertrag die App dorthin (*Transfer App to Team* in den App-Einstellungen). Der **Besitzer des Teams** ist die Person, die Discord verifiziert.

## 2. Zwei-Faktor-Anmeldung und Identität

- Der Team-Besitzer braucht **Zwei-Faktor-Authentifizierung** im Discord-Konto.
- Der Team-Besitzer bestätigt seine **Identität** bei Discords Anbieter **Stripe** (Ausweisfoto und Selfie). Den Ausweis prüft Stripe; Discord-Nutzer sehen ihn nicht.

## 3. App-Angaben, Nutzungsbedingungen und Datenschutz

Die App braucht einen **Namen**, ein **Icon**, eine **Beschreibung**, was sie tut, und die Links zu ihren **Nutzungsbedingungen** (Terms of Service) und ihrer **Datenschutzerklärung** (Privacy Policy).

BotHub hat beide Seiten fertig: `/terms` und `/privacy` auf deiner Dashboard-Domain. Trag zuerst die Betreiber-Angaben ein:

![BotHub: Betreiber-Angaben für die Rechtsseiten, angezeigt auf /terms und /privacy](/static/docs/verify-legal.svg)

1. Öffne in BotHub **Benutzermenü → Admin → Server-Einstellungen** und füll **Rechtliches: Nutzungsbedingungen und Datenschutz** aus (Betreiber, Kontakt-E-Mail; eine Adresse, wenn du den Bot regelmäßig öffentlich anbietest). Speichern.
2. Öffne `https://<deine-domain>/terms` und `/privacy` einmal und prüf sie.
3. Füg im Developer Portal unter **General Information** beide URLs ein (A und B) und speichere.

![Developer Portal: General Information mit Terms-of-Service- und Privacy-Policy-URL](/static/docs/verify-portal.svg)

> [!WARNING]
> Die Seiten müssen aus dem Internet über **https** erreichbar sein. Ein Dashboard, das nur in deinem Heimnetz läuft, reicht hier nicht: mach die Domain zuerst öffentlich (Admin → Server-Einstellungen → Domain, Reverse Proxy).

## 4. Privilegierte Intents

Nicht verifizierte Bots dürfen die privilegierten Intents frei nutzen. Verifizierte Bots müssen jeden im Tab App Verification **beantragen** und begründen. Beantrage nur, was dein Bot wirklich nutzt; BotHub läuft ohne die, die es nicht bekommt, und die Module, die sie brauchen, bleiben still (das Log sagt es).

![Wofür BotHub die privilegierten Intents nutzt](/static/docs/verify-intents.svg)

Beispiel-Begründungen zum Anpassen (Discord erwartet Englisch):

| Intent | Begründung |
|---|---|
| Server Members | "Welcome and leave messages, automatic roles, verification and member counters for the servers that switched these features on." |
| Message Content | "Moderation filters (spam, links, bad words), automatic replies and counting games that need to read the message text in servers that switched them on." |
| Presence | Nur wenn du Online-Zähler oder Status-Events nutzt. |

## 5. Absenden und warten

Wenn jeder Punkt der Checkliste grün ist, klick auf **Submit**. Discord prüft die App; das dauert von ein paar Tagen bis zu einigen Wochen. Das Ergebnis kommt als Nachricht von Discord. Fehlt etwas, behebe es und reiche erneut ein.

## Checkliste

- ☐ App in einem Team, Team-Besitzer mit 2FA
- ☐ Identität bei Stripe bestätigt
- ☐ Name, Icon, Beschreibung
- ☐ `/terms` und `/privacy` in BotHub ausgefüllt, öffentlich über https, im Portal eingetragen
- ☐ Privilegierte Intents mit Begründung beantragt (nur die genutzten)
- ☐ Mindestens 75 Server, dann **Submit**
