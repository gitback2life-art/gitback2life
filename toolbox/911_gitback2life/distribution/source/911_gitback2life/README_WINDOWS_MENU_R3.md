# Windows menu R3 — focused correction

This is an **ordinary offline development build**, not an installer. No installation, owner authorization, or production activation is performed.

## What was corrected

The R2 Windows support log proved Node and the menu launched. After menu option 1 was chosen, a Ctrl+C interruption closed the readline interface. The program caught the interruption as an operation error, then tried another question on the already-closed interface and returned exit code 2.

R3 now treats Ctrl+C during any menu prompt as a normal operator exit (exit code 0). Type `/back` during a prompted action to abandon that action and return to the main menu without creating it. Real operation failures continue to be logged and reported; startup errors remain visible. All Windows launcher log streams and Downloads support ZIP collection from R2 are retained.

## Local verification

One interactive Node.js 22 pseudo-terminal check covered action cancellation, return to main menu, successful menu option 5, ordinary exit, and the exact R2 Ctrl+C-after-option-1 sequence. Both sessions exited with code 0, without uncaught errors. This is not a native Windows execution claim.

## Test location

Extract under `C:\Users\BlueFrost\Desktop\911_gitback2life\Temp`, into a **new separate folder**. Run `TOOLBOX.cmd`. The menu and logs operate only within that extracted build; the one-click launcher places the compact support ZIP in Downloads. No files in the previous R2 build are overwritten.
