# shipx — VHS demo recording
#
# Generates: .github/assets/demo.gif
#
# Re-record:
#   brew install vhs   # or: go install github.com/charmbracelet/vhs@latest
#   vhs media/demo.tape

Output .github/assets/demo.gif

Set Shell bash
Set FontSize 16
Set FontFamily "JetBrainsMono Nerd Font Mono"
Set Width 1200
Set Height 760
Set Padding 30
Set Margin 24
Set MarginFill "#0a0510"
Set BorderRadius 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 60ms

# --- Hidden setup: spin up a throwaway demo project --------------------------
Hide
Type "source media/setup-demo.sh >/dev/null && clear"
Enter
Sleep 1500ms

# --- Visible recording -------------------------------------------------------
Show
Type "shipx"
Sleep 400ms
Enter

# Intro + preflight render
Sleep 2500ms

# Version picker — default selection is "patch". Move down to "minor".
Down
Sleep 500ms
Enter

# Confirm prompt appears with "Release 0.1.0 → 0.2.0 (v0.2.0)?"
Sleep 1200ms
Enter

# Watch the spinners: bump → changelog → commit & tag → (push/npm/homebrew skipped)
Sleep 5500ms

# Hold on the outro
Sleep 2500ms
