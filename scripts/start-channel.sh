#!/bin/bash
# Start Claude Code with Naver Works channel in tmux.
# Usage: bash scripts/start-channel.sh

export PATH="/opt/homebrew/bin:$HOME/.bun/bin:$PATH"

SESSION_NAME="naverworks-channel"

# Kill existing session
tmux kill-session -t "$SESSION_NAME" 2>/dev/null

# Start new tmux session with Claude + channel
# Send Enter to auto-confirm the development channel prompt
tmux new-session -d -s "$SESSION_NAME" \
  "claude --dangerously-load-development-channels server:naverworks"
sleep 3
tmux send-keys -t "$SESSION_NAME" Enter

echo "Started tmux session: $SESSION_NAME"
echo "Attach with: tmux attach -t $SESSION_NAME"
