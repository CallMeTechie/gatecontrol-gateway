#!/bin/bash -e
# Docker beim Booten starten; Version für das Bauprotokoll ausgeben.
on_chroot <<CHROOT
systemctl enable docker.service containerd.service
dpkg-query -W -f='\${Package} \${Version}\n' docker-ce containerd.io docker-compose-plugin
CHROOT
