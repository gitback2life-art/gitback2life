# Opportunity Tracker

A small, privacy-first browser tool for organizing legitimate opportunities while rebuilding toward independence.

## Why it exists

Opportunity research can become chaotic: links get lost, deadlines get missed, and questionable offers can look attractive when the project is trying to move quickly.

This prototype treats an opportunity like a small research record instead:

- what is it?
- where did it come from?
- what does it require?
- when does it matter?
- what is its current status?
- what evidence or concerns should be remembered?

## Design goals

- $0 upfront cost
- no server
- no account required
- local browser storage
- JSON export/import for backup
- simple status and deadline tracking
- explicit scam/risk notes
- no automatic applications or transactions
- no claim that an opportunity is legitimate merely because it was entered

## Privacy

Data stays in the browser's local storage unless the user deliberately exports or shares the JSON file.

Do not enter passwords, payment-card details, government identifiers, or other sensitive information.

## Run it

Open `index.html` in a modern browser.

### Optional sample import

[`utest-academy-research-record.json`](utest-academy-research-record.json) is one researched candidate record you can import with **Import JSON**. It is marked **Researching** with **Unknown** risk; it is not a verified open paid assignment or a recommendation to create an account. Read [the evaluation](../../research/2026-10-08-utest-evaluation.md) first. The sample contains no personal account or payment details.

The prototype is dependency-free and can also be served as static files from any free static host.

## Status

Prototype / learning project.

The goal is to learn by building a small useful tool, then decide from evidence whether it deserves more development.