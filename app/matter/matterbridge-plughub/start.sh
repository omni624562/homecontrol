#!/bin/sh
# 容器啟動時：讓外掛找得到 matterbridge，第一次啟動時登記外掛，然後啟動 Matterbridge
set -e
PLUGIN=/root/Matterbridge/matterbridge-plughub
mkdir -p "$PLUGIN/node_modules"
ln -sfn "$(npm root -g)/matterbridge" "$PLUGIN/node_modules/matterbridge"
if [ ! -f /root/.matterbridge/.plughub-added ]; then
  matterbridge --add "$PLUGIN"
  touch /root/.matterbridge/.plughub-added
fi
# 只在家裡的網路卡廣播（避開 VPN 之類的介面）
exec matterbridge --docker --bridge --mdnsinterface "${MDNS_INTERFACE:-eth0}"
