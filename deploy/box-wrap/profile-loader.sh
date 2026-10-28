# CoCell publishes shell setup to the shared mount so new shells pick up
# changes without an image rebuild; the image copy covers Boxes without it.
cocell_profile=/var/lib/cellbox/shared/tool-wrap/current/deploy/box-wrap/tool-path.sh
if [ ! -r "$cocell_profile" ]; then
  cocell_profile=/opt/product/cocell/tool-path.sh
fi
if [ -r "$cocell_profile" ]; then
  . "$cocell_profile"
fi
unset cocell_profile
