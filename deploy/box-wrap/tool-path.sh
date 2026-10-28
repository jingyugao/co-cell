# Keep shared CoCell tools ahead of the inherited PATH.
if [ -d /var/lib/cellbox/shared/tools/current/bin ]; then
  PATH="/var/lib/cellbox/shared/tools/current/bin:$PATH"
fi
# Some images install Go here without adding it to their PATH.
if [ -d /usr/local/go/bin ]; then
  case ":$PATH:" in
    *:/usr/local/go/bin:*) ;;
    *) PATH="$PATH:/usr/local/go/bin" ;;
  esac
fi
export PATH
