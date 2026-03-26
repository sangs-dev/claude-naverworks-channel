#!/bin/bash
# Auto-start Claude Code with Naver Works channel via tmux.
# Designed for launchd RunAtLoad — no interactive terminal needed.

export PATH="/Users/twomos/.local/bin:/opt/homebrew/bin:/Users/twomos/.bun/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export HOME="/Users/twomos"
export SHELL="/bin/zsh"
export TERM="xterm-256color"

SESSION_NAME="naverworks-channel"
LOG="/tmp/naverworks-channel.out"

echo "$(date): start-channel-auto.sh invoked" >> "$LOG"

# Ensure tmux server is running
/opt/homebrew/bin/tmux start-server 2>>"$LOG"

# Kill existing session if any
/opt/homebrew/bin/tmux kill-session -t "$SESSION_NAME" 2>/dev/null

sleep 1

# Create new detached session
/opt/homebrew/bin/tmux new-session -d -s "$SESSION_NAME" -x 120 -y 30 \
  "claude --dangerously-load-development-channels server:naverworks" 2>>"$LOG"

echo "$(date): tmux session created" >> "$LOG"

# Wait for confirmation prompt, then auto-confirm
sleep 8
/opt/homebrew/bin/tmux send-keys -t "$SESSION_NAME" Enter 2>>"$LOG"

# Wait for possible workspace trust prompt
sleep 5
/opt/homebrew/bin/tmux send-keys -t "$SESSION_NAME" Enter 2>>"$LOG"

echo "$(date): auto-confirm sent" >> "$LOG"
