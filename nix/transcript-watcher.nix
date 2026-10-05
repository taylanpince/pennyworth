# Home Manager module: user-level systemd path watcher that wakes the Meeting Librarian
# when transcript files change. Opt-in; it never touches system-wide configuration.
#
# Usage (in your Home Manager config):
#
#   imports = [ /home/you/development/pennyworth/nix/transcript-watcher.nix ];
#   services.pennyworth-transcripts = {
#     enable = true;
#     repoPath = "/home/you/development/pennyworth";
#     transcriptsDir = "/home/you/Documents/transcripts";
#   };
#
# The watcher only sends a signed, content-free webhook ("meeting artifacts may have
# changed"). ops-mcp discovers the actual files, so missed or repeated events are harmless.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.pennyworth-transcripts;
in
{
  options.services.pennyworth-transcripts = {
    enable = lib.mkEnableOption "Pennyworth transcript watcher";

    repoPath = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path of the Pennyworth checkout (scripts/trigger-meeting-scan.sh lives there).";
    };

    transcriptsDir = lib.mkOption {
      type = lib.types.str;
      description = "Directory where transcripts are written (watched, including direct subdirectories).";
    };

    extraDirs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [ "/home/you/Documents/transcripts/1-1s" ];
      description = "Additional directories to watch (PathChanged is not recursive).";
    };

    secretsDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.configHome}/pennyworth";
      description = "Directory holding meeting_webhook_url and meeting_webhook_secret (never the Nix store).";
    };

    settleSeconds = lib.mkOption {
      type = lib.types.int;
      default = 15;
      description = "Delay before firing, so a file being written triggers once (ops-mcp also waits for stability).";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.user.paths.pennyworth-transcripts = {
      Unit.Description = "Watch meeting transcripts for Pennyworth";
      Path = {
        PathChanged = [ cfg.transcriptsDir ] ++ cfg.extraDirs;
        Unit = "pennyworth-transcripts.service";
        TriggerLimitIntervalSec = 30;
        TriggerLimitBurst = 4;
      };
      Install.WantedBy = [ "paths.target" ];
    };

    systemd.user.services.pennyworth-transcripts = {
      Unit.Description = "Wake the Pennyworth Meeting Librarian";
      Service = {
        Type = "oneshot";
        Environment = [
          "PENNYWORTH_SECRETS_DIR=${cfg.secretsDir}"
          "PATH=${lib.makeBinPath [ pkgs.bash pkgs.coreutils pkgs.curl pkgs.openssl pkgs.gnused ]}"
        ];
        ExecStartPre = "${pkgs.coreutils}/bin/sleep ${toString cfg.settleSeconds}";
        ExecStart = "${pkgs.bash}/bin/bash ${cfg.repoPath}/scripts/trigger-meeting-scan.sh";
        # Hardening: the script only needs to read two secret files and call localhost.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = "read-only";
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      };
    };
  };
}
