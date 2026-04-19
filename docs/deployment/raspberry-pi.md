# Deployment: Raspberry Pi

## Empfehlungen

- **Raspberry Pi 3B+ oder neuer** (Pi Zero W hat zu wenig RAM für Proxy + mehrere Listener)
- **Externe SSD auf USB** statt SD-Card (SD-Cards verschleißen durch ständige Log-Writes)
- Alternativ: Read-Only-Root-FS mit Log-Volume auf tmpfs

## SSD-on-USB Setup

```bash
# 1. USB-SSD formatieren + mounten auf /mnt/ssd
sudo mkfs.ext4 /dev/sda1
sudo mkdir /mnt/ssd
sudo mount /dev/sda1 /mnt/ssd

# 2. Docker-Root-Dir umziehen (spart SD-Wear)
sudo systemctl stop docker
sudo mv /var/lib/docker /mnt/ssd/docker
sudo ln -s /mnt/ssd/docker /var/lib/docker
sudo systemctl start docker
```

## Log-Rotation (falls kein SSD)

Bereits im `docker-compose.example.yml` aktiv:
```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

## NTP-Check

Pi ohne RTC: bei jedem Boot muss NTP synchronisieren. Empfohlen: systemd-timesyncd oder chrony. Check:

```bash
timedatectl status
```

Sollte „System clock synchronized: yes" zeigen.
