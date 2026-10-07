# Publishes the Pennyworth board's LAN name (default pennyworth.local) over mDNS, pointing at this
# machine's Wi-Fi address, only while connected to your home Wi-Fi (docs/DECISIONS.md D-23). It
# follows address changes (DHCP) and Wi-Fi switches.
#
# A system service: avahi lets only root publish addresses (unless user publishing is opened up
# for every local user). It runs with no capabilities, a read-only system and no home access.
#
# Flakes evaluate purely, so copy this file into your NixOS config, then:
#   imports = [ ./modules/pennyworth-mdns.nix ];
#   services.pennyworth-mdns = { enable = true; ssid = "MyWifi"; };
# Needs services.avahi.enable (with nssmdns4 for .local lookups on this machine).
{ config, lib, pkgs, ... }:

let
  cfg = config.services.pennyworth-mdns;
  publisher = pkgs.writeShellApplication {
    name = "pennyworth-mdns";
    runtimeInputs = [ pkgs.avahi pkgs.networkmanager pkgs.iproute2 pkgs.gawk pkgs.coreutils ];
    text = ''
      name="''${PENNYWORTH_MDNS_NAME:-pennyworth.local}"
      ssid="''${PENNYWORTH_MDNS_SSID:-}"
      pid=""
      current=""
      stop() {
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        pid=""
      }
      trap 'stop; exit 0' TERM INT

      while true; do
        want=""
        dev="$(nmcli -t -f DEVICE,TYPE,STATE device 2>/dev/null | awk -F: '$2 == "wifi" && $3 == "connected" { print $1; exit }' || true)"
        if [ -n "$dev" ]; then
          on_home=1
          if [ -n "$ssid" ]; then
            list="$(nmcli -t -f active,ssid device wifi list ifname "$dev" --rescan no 2>/dev/null || true)"
            [[ $'\n'"$list"$'\n' == *$'\n'"yes:$ssid"$'\n'* ]] || on_home=0
          fi
          if [ "$on_home" = 1 ]; then
            want="$(ip -4 -o addr show dev "$dev" scope global | awk '{ split($4, a, "/"); print a[1]; exit }' || true)"
          fi
        fi
        alive=1
        if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then alive=0; fi
        if [ "$want" != "$current" ] || [ "$alive" = 0 ]; then
          stop
          current="$want"
          if [ -n "$want" ]; then
            avahi-publish -a -R "$name" "$want" &
            pid=$!
            echo "publishing $name -> $want"
          else
            echo "$name not published (not on ''${ssid:-Wi-Fi})"
          fi
        fi
        sleep 15
      done
    '';
  };
in
{
  options.services.pennyworth-mdns = {
    enable = lib.mkEnableOption "the pennyworth.local mDNS name for the Pennyworth board";
    name = lib.mkOption {
      type = lib.types.str;
      default = "pennyworth.local";
      description = "Name to publish (must match BOARD_LAN_HOSTS in Pennyworth's .env).";
    };
    ssid = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Only publish while connected to this Wi-Fi network (null: on any Wi-Fi).";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [{ assertion = config.services.avahi.enable; message = "services.pennyworth-mdns needs services.avahi.enable"; }];
    systemd.services.pennyworth-mdns = {
      description = "Publish ${cfg.name} (Pennyworth board) on the home network";
      after = [ "avahi-daemon.service" "NetworkManager.service" ];
      requires = [ "avahi-daemon.service" ];
      wantedBy = [ "multi-user.target" ];
      environment = { PENNYWORTH_MDNS_NAME = cfg.name; } // lib.optionalAttrs (cfg.ssid != null) { PENNYWORTH_MDNS_SSID = cfg.ssid; };
      serviceConfig = {
        ExecStart = "${publisher}/bin/pennyworth-mdns";
        Restart = "always";
        RestartSec = 10;
        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [ "AF_UNIX" "AF_NETLINK" ];
        RestrictNamespaces = true;
        LockPersonality = true;
        MemoryDenyWriteExecute = true;
        SystemCallArchitectures = "native";
      };
    };
  };
}
