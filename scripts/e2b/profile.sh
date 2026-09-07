# E2B commands and Codex tools use login shells, whose /etc/profile resets PATH.
# Keep project-aware mise shims available in those shells as well as direct exec.
if [ "$HOME" = /home/user ]; then
  export PATH="/home/user/.local/share/mise/shims:/home/user/.local/bin:$PATH"
fi
