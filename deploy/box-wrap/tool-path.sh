# Keep shared CoCell tools ahead of the inherited PATH.
if [ -d /var/lib/cellbox/shared/tools/current/bin ]; then
  PATH="/var/lib/cellbox/shared/tools/current/bin:$PATH"
  export PATH
fi
