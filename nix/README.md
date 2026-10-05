# NixOS snippets (all opt-in)

Nothing in this repository changes your system configuration automatically, and no script uses `sudo`. The snippets below are for you to add yourself.

## 1. Transcript watcher (Home Manager)

```nix
# home.nix
imports = [ /home/taylan/development/pennyworth/nix/transcript-watcher.nix ];

services.pennyworth-transcripts = {
  enable = true;
  repoPath = "/home/taylan/development/pennyworth";
  transcriptsDir = "/home/taylan/Documents/transcripts";
  extraDirs = [ "/home/taylan/Documents/transcripts/1-1s" ];   # PathChanged is not recursive
};
```

Then apply your Home Manager configuration and check:

```sh
systemctl --user status pennyworth-transcripts.path
journalctl --user -u pennyworth-transcripts.service -f
```

**Without Home Manager.** Create the two unit files by hand:

```ini
# ~/.config/systemd/user/pennyworth-transcripts.path
[Unit]
Description=Watch meeting transcripts for Pennyworth
[Path]
PathChanged=%h/Documents/transcripts
PathChanged=%h/Documents/transcripts/1-1s
TriggerLimitIntervalSec=30
TriggerLimitBurst=4
[Install]
WantedBy=paths.target
```

```ini
# ~/.config/systemd/user/pennyworth-transcripts.service
[Unit]
Description=Wake the Pennyworth Meeting Librarian
[Service]
Type=oneshot
ExecStartPre=/run/current-system/sw/bin/sleep 15
ExecStart=/run/current-system/sw/bin/bash %h/development/pennyworth/scripts/trigger-meeting-scan.sh
NoNewPrivileges=true
```

```sh
systemctl --user daemon-reload && systemctl --user enable --now pennyworth-transcripts.path
```

`trigger-meeting-scan.sh` needs `curl` and `openssl` on its PATH.

## 2. Rootless Docker (recommended)

This host currently runs **rootful** Docker, and your user is in the `docker` group, which is root-equivalent. The spec's intended runtime is rootless Docker:

```nix
# configuration.nix
virtualisation.docker.rootless = {
  enable = true;
  setSocketVariable = true;   # exports DOCKER_HOST for your user
};
# Optional, once nothing else needs the system daemon:
# virtualisation.docker.enable = false;
# users.users.taylan.extraGroups = lib.remove "docker" [ ... ];
```

After you switch, rebuild the images (`docker compose build`) and copy `./data` across as-is. Under rootless Docker, container uid 0 maps to your user, so you can drop the `PUID`/`PGID` overrides if you see permission issues. Re-run `scripts/verify-security.sh` afterwards.

## 3. Firewall note (NordVPN)

The NordVPN firewall on this host drops traffic to Docker's default `172.16.0.0/12` pools, except `docker0`. That broke the published `127.0.0.1:3100` port. `compose.yaml` therefore pins its networks to `10.231.0.0/24` and `10.231.1.0/24`. If those collide with something on your network, override `PENNYWORTH_BACKPLANE_SUBNET` / `PENNYWORTH_EGRESS_SUBNET` in `.env`. No firewall change is needed.

## 4. Optional packages

The scripts need `docker` (with the compose plugin), `node` ≥ 24, `curl`, `openssl` and `git`. They are all in your system profile already.
