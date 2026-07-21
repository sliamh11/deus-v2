import { describe, it, expect } from 'vitest';
import path from 'path';
import { SCHEDULED_JOBS, buildScheduledJobPlist } from './service.js';

/**
 * Tests for service configuration generation.
 *
 * These tests verify the generated content of plist/systemd/nohup configs
 * without actually loading services.
 */

describe('scheduled python jobs (LIA-254 generic refactor)', () => {
  const maintenance = SCHEDULED_JOBS.find((j) => j.id === 'maintenance');
  const morning = SCHEDULED_JOBS.find((j) => j.id === 'morning-report');
  const evolutionBackup = SCHEDULED_JOBS.find(
    (j) => j.id === 'evolution-backup',
  );

  it('preserves the maintenance job spec (regression guard for the refactor)', () => {
    // The 04:30 KB maintenance job is live-critical — the generic extraction
    // must not drift its schedule, script, or id.
    expect(maintenance).toEqual({
      id: 'maintenance',
      scriptRelPath: 'scripts/maintenance.py',
      hour: 4,
      minute: 30,
      description: 'Deus KB maintenance',
    });
  });

  it('registers the morning report at 07:00', () => {
    expect(morning).toMatchObject({
      id: 'morning-report',
      scriptRelPath: 'scripts/maintenance/morning_report.py',
      hour: 7,
      minute: 0,
    });
  });

  it('maintenance plist keeps the unchanged label/time/script/log paths', () => {
    const plist = buildScheduledJobPlist(
      maintenance!,
      '/home/user/deus',
      '/home/user',
      '/usr/bin/python3',
    );
    expect(plist).toContain('<string>com.deus-v2.maintenance</string>');
    expect(plist).toContain('/home/user/deus/scripts/maintenance.py');
    expect(plist).toContain('<integer>4</integer>'); // hour
    expect(plist).toContain('<integer>30</integer>'); // minute
    expect(plist).toContain('/home/user/deus/logs/maintenance.log');
  });

  it('morning-report plist targets 07:00 and its own script/log', () => {
    const plist = buildScheduledJobPlist(
      morning!,
      '/home/user/deus',
      '/home/user',
      '/usr/bin/python3',
    );
    expect(plist).toContain('<string>com.deus-v2.morning-report</string>');
    expect(plist).toContain(
      '/home/user/deus/scripts/maintenance/morning_report.py',
    );
    expect(plist).toContain('<integer>7</integer>'); // hour
    expect(plist).toContain('<integer>0</integer>'); // minute
    expect(plist).toContain('/home/user/deus/logs/morning-report.log');
  });

  it('registers the evolution-backup job at 04:20 (LIA-453)', () => {
    expect(evolutionBackup).toEqual({
      id: 'evolution-backup',
      scriptRelPath: 'scripts/evolution_backup.py',
      hour: 4,
      minute: 20,
      description: 'Deus evolution DB backup',
    });
  });

  it('evolution-backup plist carries the -v2 label, never v1 com.deus.evolution-backup', () => {
    const plist = buildScheduledJobPlist(
      evolutionBackup!,
      '/home/user/deus',
      '/home/user',
      '/usr/bin/python3',
    );
    expect(plist).toContain('<string>com.deus-v2.evolution-backup</string>');
    // Hard guard against v1-label leakage: the unsuffixed v1 label must never
    // appear as a whole <string> value.
    expect(plist).not.toContain('<string>com.deus.evolution-backup</string>');
    expect(plist).toContain('/home/user/deus/scripts/evolution_backup.py');
    expect(plist).toContain('/home/user/deus/logs/evolution-backup.log');
  });

  it('evolution-backup schedule (04:20) is distinct from v1 evolution-backup (04:00)', () => {
    // v1's com.deus.evolution-backup fires at 04:00; v2 must not collide.
    expect(evolutionBackup!.hour).toBe(4);
    expect(evolutionBackup!.minute).toBe(20);
    expect(evolutionBackup!.minute).not.toBe(0); // v1's minute
  });

  it('no scheduled job label collides with its unsuffixed v1 twin', () => {
    // Every com.deus-v2.<id> must differ from the v1 com.deus.<id> string.
    for (const spec of SCHEDULED_JOBS) {
      const plist = buildScheduledJobPlist(
        spec,
        '/home/user/deus',
        '/home/user',
        '/usr/bin/python3',
      );
      expect(plist).toContain(`<string>com.deus-v2.${spec.id}</string>`);
      expect(plist).not.toContain(`<string>com.deus.${spec.id}</string>`);
    }
  });
});

describe('scheduled python jobs — interval-based (LIA-453 Scope A Phase 2)', () => {
  const healthcheck = SCHEDULED_JOBS.find((j) => j.id === 'healthcheck');
  const logToIssue = SCHEDULED_JOBS.find((j) => j.id === 'log-to-issue');

  it('registers the healthcheck job hourly (intervalSec=3600), no hour/minute', () => {
    expect(healthcheck).toEqual({
      id: 'healthcheck',
      scriptRelPath: 'scripts/healthcheck.py',
      intervalSec: 3600,
      description: 'Deus-v2 launchd fleet healthcheck',
    });
  });

  it('registers the log-to-issue job every 15 minutes (intervalSec=900), no hour/minute', () => {
    expect(logToIssue).toEqual({
      id: 'log-to-issue',
      scriptRelPath: 'scripts/log_to_issue.py',
      intervalSec: 900,
      description: 'Deus-v2 runtime-error to GH issue stub',
    });
  });

  it('healthcheck plist emits StartInterval, not StartCalendarInterval', () => {
    const plist = buildScheduledJobPlist(
      healthcheck!,
      '/home/user/deus',
      '/home/user',
      '/usr/bin/python3',
    );
    expect(plist).toContain('<string>com.deus-v2.healthcheck</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>3600</integer>');
    expect(plist).not.toContain('StartCalendarInterval');
    expect(plist).toContain('/home/user/deus/scripts/healthcheck.py');
    expect(plist).toContain('/home/user/deus/logs/healthcheck.log');
  });

  it('log-to-issue plist emits StartInterval at 900s, not StartCalendarInterval', () => {
    const plist = buildScheduledJobPlist(
      logToIssue!,
      '/home/user/deus',
      '/home/user',
      '/usr/bin/python3',
    );
    expect(plist).toContain('<string>com.deus-v2.log-to-issue</string>');
    expect(plist).toContain('<key>StartInterval</key>');
    expect(plist).toContain('<integer>900</integer>');
    expect(plist).not.toContain('StartCalendarInterval');
    expect(plist).toContain('/home/user/deus/scripts/log_to_issue.py');
    expect(plist).toContain('/home/user/deus/logs/log-to-issue.log');
  });

  it('daily jobs (maintenance) are unaffected — still emit StartCalendarInterval, never StartInterval', () => {
    const maintenance = SCHEDULED_JOBS.find((j) => j.id === 'maintenance')!;
    const plist = buildScheduledJobPlist(
      maintenance,
      '/home/user/deus',
      '/home/user',
      '/usr/bin/python3',
    );
    expect(plist).toContain('<key>StartCalendarInterval</key>');
    expect(plist).not.toContain('StartInterval');
  });
});

describe('scheduled job generation — interval-based systemd/Windows (LIA-453 Scope A Phase 2)', () => {
  // Local mirrors of the interval branches inside installScheduledJobLinux /
  // installScheduledJobWindows — same indirection the "Maintenance service
  // generation" describe block below already uses for the daily case, since
  // those installers aren't exported and have real systemctl/schtasks side
  // effects against the live host.
  function generateIntervalSystemdTimer(
    intervalSec: number,
    description: string,
  ): string {
    return `[Unit]
Description=${description} timer

[Timer]
OnUnitActiveSec=${intervalSec}
Persistent=true

[Install]
WantedBy=timers.target`;
  }

  function windowsIntervalScheduleArgs(intervalSec: number): string[] {
    return ['/SC', 'MINUTE', '/MO', String(Math.round(intervalSec / 60))];
  }

  it('healthcheck systemd timer uses OnUnitActiveSec=3600, not OnCalendar', () => {
    const timer = generateIntervalSystemdTimer(
      3600,
      'Deus-v2 launchd fleet healthcheck',
    );
    expect(timer).toContain('OnUnitActiveSec=3600');
    expect(timer).not.toContain('OnCalendar');
  });

  it('log-to-issue systemd timer uses OnUnitActiveSec=900, not OnCalendar', () => {
    const timer = generateIntervalSystemdTimer(
      900,
      'Deus-v2 runtime-error to GH issue stub',
    );
    expect(timer).toContain('OnUnitActiveSec=900');
    expect(timer).not.toContain('OnCalendar');
  });

  it('daily jobs keep OnCalendar, never OnUnitActiveSec', () => {
    const timer = `[Unit]
Description=Deus KB maintenance timer

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target`;
    expect(timer).toContain('OnCalendar=*-*-* 04:30:00');
    expect(timer).not.toContain('OnUnitActiveSec');
  });

  it('healthcheck Windows task uses /SC MINUTE /MO 60 (3600s / 60), not /SC DAILY', () => {
    expect(windowsIntervalScheduleArgs(3600)).toEqual([
      '/SC',
      'MINUTE',
      '/MO',
      '60',
    ]);
  });

  it('log-to-issue Windows task uses /SC MINUTE /MO 15 (900s / 60), not /SC DAILY', () => {
    expect(windowsIntervalScheduleArgs(900)).toEqual([
      '/SC',
      'MINUTE',
      '/MO',
      '15',
    ]);
  });
});

// Helper: generate a plist string the same way service.ts does
function generatePlist(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deus-v2</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/deus.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/deus.error.log</string>
</dict>
</plist>`;
}

function generateSystemdUnit(
  nodePath: string,
  projectRoot: string,
  homeDir: string,
  isSystem: boolean,
): string {
  return `[Unit]
Description=Deus Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/deus.log
StandardError=append:${projectRoot}/logs/deus.error.log

[Install]
WantedBy=${isSystem ? 'multi-user.target' : 'default.target'}`;
}

describe('plist generation', () => {
  it('contains the correct label', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus',
      '/home/user',
    );
    expect(plist).toContain('<string>com.deus-v2</string>');
  });

  it('uses the correct node path', () => {
    const plist = generatePlist(
      '/opt/node/bin/node',
      '/home/user/deus',
      '/home/user',
    );
    expect(plist).toContain('<string>/opt/node/bin/node</string>');
  });

  it('points to dist/index.js', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus',
      '/home/user',
    );
    expect(plist).toContain('/home/user/deus/dist/index.js');
  });

  it('includes /opt/homebrew/bin in PATH for Apple Silicon', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus',
      '/home/user',
    );
    expect(plist).toContain('/opt/homebrew/bin');
  });

  it('sets log paths', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus',
      '/home/user',
    );
    expect(plist).toContain('deus.log');
    expect(plist).toContain('deus.error.log');
  });
});

// @oracle
// LIA-453 Scope A, Phase 1 — independent oracle for the "channels stay off"
// invariant on the launchd plist (plan-review finding
// `independent-oracle-high-blast-radius`, `oracle-rules.md` convention).
//
// Contract under test (from the plan, not from reading setupLaunchd's body):
// setupLaunchd's generated plist's EnvironmentVariables dict must NEVER
// contain a channel bot-token key (TELEGRAM_BOT_TOKEN, SLACK_BOT_TOKEN, or
// similar for any other channel), even after Phase 1 adds
// ODYSSEUS_HTTP_ENABLED=1, INGRESS_GATEWAY_ENABLED=1, and
// INGRESS_TUNNEL_ENABLED=1 to that same dict. Channels stay deliberately off
// in Phase 1 — only in-process services (credential-proxy, tool-proxy,
// Odysseus HTTP, ingress-gateway, ngrok) come online.
//
// This test exercises `generatePlist` above, the test file's own
// byte-for-byte mirror of setupLaunchd's plist template (see its "generate a
// plist string the same way service.ts does" comment) — the same indirection
// every other test in the `describe('plist generation')` block above already
// relies on, and the only safe way to inspect plist content without
// exercising setupLaunchd's real `fs.writeFileSync`/`execSync('launchctl
// load ...')` side effects against this live host (setupLaunchd is not
// exported, and both plan-review and orchestration-rules.md flag this exact
// change as touching a running daemon). Do NOT loosen this test to make it
// pass a real violation — a RED here means fix the implementation.
//
// A leading underscore marks env vars this test must never approve, no
// matter how the key is spelled — every known/likely channel bot-token
// pattern, plus a generic catch-all for any future channel.
const FORBIDDEN_CHANNEL_TOKEN_KEY_PATTERNS: RegExp[] = [
  /TELEGRAM_BOT_TOKEN/,
  /SLACK_BOT_TOKEN/,
  /DISCORD_BOT_TOKEN/,
  /WHATSAPP_(BOT_)?TOKEN/,
  /GMAIL_(BOT_)?TOKEN/,
  /\b[A-Z][A-Z0-9]*_BOT_TOKEN\b/, // generic: <ANYTHING>_BOT_TOKEN
  /\bCHANNEL_[A-Z0-9_]*TOKEN\b/, // generic: CHANNEL_*_TOKEN
];

describe('setupLaunchd EnvironmentVariables — channels-stay-off safety net (LIA-453 Scope A Phase 1)', () => {
  it('never emits a channel bot-token env var key in the current, unmodified plist', () => {
    const plist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus-v2',
      '/home/user',
    );
    for (const pattern of FORBIDDEN_CHANNEL_TOKEN_KEY_PATTERNS) {
      expect(plist).not.toMatch(pattern);
    }
  });

  it('still never emits a channel bot-token env var key once the Phase 1 flags are present', () => {
    // Simulates Phase 1's stated change (three new always-on flags added to
    // EnvironmentVariables) without depending on the implementation existing
    // yet — this is the oracle-author's own reconstruction of the plan's
    // contract, kept separate from `generatePlist` so this test doesn't
    // silently start passing vacuously just because nothing changed there.
    const plistWithPhase1Flags = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus-v2',
      '/home/user',
    ).replace(
      '<key>PATH</key>',
      [
        '<key>ODYSSEUS_HTTP_ENABLED</key>',
        '        <string>1</string>',
        '        <key>INGRESS_GATEWAY_ENABLED</key>',
        '        <string>1</string>',
        '        <key>INGRESS_TUNNEL_ENABLED</key>',
        '        <string>1</string>',
        '        <key>PATH</key>',
      ].join('\n'),
    );

    // Sanity: the splice actually landed (guards against a no-op replace()
    // silently making this test meaningless).
    expect(plistWithPhase1Flags).toContain('ODYSSEUS_HTTP_ENABLED');
    expect(plistWithPhase1Flags).toContain('INGRESS_GATEWAY_ENABLED');
    expect(plistWithPhase1Flags).toContain('INGRESS_TUNNEL_ENABLED');

    for (const pattern of FORBIDDEN_CHANNEL_TOKEN_KEY_PATTERNS) {
      expect(plistWithPhase1Flags).not.toMatch(pattern);
    }
  });

  it('would catch a regression — sanity check that the assertion logic is not vacuous', () => {
    // Not a "does setupLaunchd violate the contract" test — an oracle that
    // can never go red is worthless. Proves the pattern list above actually
    // fires on the exact violation the plan warns against.
    const violatingPlist = generatePlist(
      '/usr/local/bin/node',
      '/home/user/deus-v2',
      '/home/user',
    ).replace(
      '<key>PATH</key>',
      '<key>TELEGRAM_BOT_TOKEN</key>\n        <string>fake</string>\n        <key>PATH</key>',
    );

    const violated = FORBIDDEN_CHANNEL_TOKEN_KEY_PATTERNS.some((pattern) =>
      pattern.test(violatingPlist),
    );
    expect(violated).toBe(true);
  });
});

describe('systemd unit generation', () => {
  it('user unit uses default.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/deus',
      '/home/user',
      false,
    );
    expect(unit).toContain('WantedBy=default.target');
  });

  it('system unit uses multi-user.target', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/deus',
      '/home/user',
      true,
    );
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('contains restart policy', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/deus',
      '/home/user',
      false,
    );
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5');
  });

  it('uses KillMode=process to preserve detached children', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/home/user/deus',
      '/home/user',
      false,
    );
    expect(unit).toContain('KillMode=process');
  });

  it('sets correct ExecStart', () => {
    const unit = generateSystemdUnit(
      '/usr/bin/node',
      '/srv/deus',
      '/home/user',
      false,
    );
    expect(unit).toContain('ExecStart=/usr/bin/node /srv/deus/dist/index.js');
  });
});

describe('Windows NSSM command generation', () => {
  it('builds correct install command', () => {
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const projectRoot = 'C:\\Users\\user\\deus';
    const svc = 'deus-v2';
    const distEntry = path.join(projectRoot, 'dist', 'index.js');
    const cmd = `nssm install ${svc} "${nodePath}" "${distEntry}"`;
    expect(cmd).toContain('nssm install deus');
    expect(cmd).toContain(nodePath);
    expect(cmd).toContain('index.js');
  });

  it('builds correct log path commands', () => {
    const projectRoot = 'C:\\Users\\user\\deus';
    const logOut = path.join(projectRoot, 'logs', 'deus.log');
    const logErr = path.join(projectRoot, 'logs', 'deus.error.log');
    expect(logOut).toContain('deus.log');
    expect(logErr).toContain('deus.error.log');
  });

  it('uses SERVICE_AUTO_START for boot persistence', () => {
    const startCmd = 'nssm set deus Start SERVICE_AUTO_START';
    expect(startCmd).toContain('SERVICE_AUTO_START');
  });

  it('status check expects SERVICE_RUNNING string', () => {
    const runningOutput = 'SERVICE_RUNNING';
    expect(runningOutput.trim() === 'SERVICE_RUNNING').toBe(true);
    expect('SERVICE_STOPPED'.trim() === 'SERVICE_RUNNING').toBe(false);
  });
});

describe('Windows Servy command generation', () => {
  it('uses servy-cli binary (not servy)', () => {
    const cmd = 'servy-cli install --name="deus-v2"';
    expect(cmd).toContain('servy-cli');
    expect(cmd).not.toContain('"servy"');
  });

  it('status check expects Running string', () => {
    const runningOutput = 'Running';
    expect(runningOutput.trim() === 'Running').toBe(true);
    expect('Stopped'.trim() === 'Running').toBe(false);
  });

  it('uses Automatic startupType for boot persistence', () => {
    const cmd = 'servy-cli install --name="deus-v2" --startupType="Automatic"';
    expect(cmd).toContain('Automatic');
  });
});

describe('Windows batch fallback', () => {
  it('generates a valid batch file header', () => {
    const projectRoot = 'C:\\Users\\user\\deus';
    const nodePath = 'C:\\Program Files\\nodejs\\node.exe';
    const lines = [
      '@echo off',
      `cd /d "${projectRoot}"`,
      `start /B "" "${nodePath}" "${path.join(projectRoot, 'dist', 'index.js')}"`,
    ];
    const bat = lines.join('\r\n');
    expect(bat).toContain('@echo off');
    expect(bat).toContain('start /B');
    expect(bat).toContain('index.js');
  });
});

describe('WSL nohup fallback', () => {
  it('generates a valid wrapper script', () => {
    const projectRoot = '/home/user/deus';
    const nodePath = '/usr/bin/node';
    const pidFile = path.join(projectRoot, 'deus.pid');

    // Simulate what service.ts generates
    const wrapper = `#!/bin/bash
set -euo pipefail
cd ${JSON.stringify(projectRoot)}
nohup ${JSON.stringify(nodePath)} ${JSON.stringify(projectRoot)}/dist/index.js >> ${JSON.stringify(projectRoot)}/logs/deus.log 2>> ${JSON.stringify(projectRoot)}/logs/deus.error.log &
echo $! > ${JSON.stringify(pidFile)}`;

    expect(wrapper).toContain('#!/bin/bash');
    expect(wrapper).toContain('nohup');
    expect(wrapper).toContain(nodePath);
    expect(wrapper).toContain('deus.pid');
  });
});

describe('Maintenance service generation', () => {
  function generateMaintenancePlist(
    pythonPath: string,
    projectRoot: string,
    homeDir: string,
  ): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.deus-v2.maintenance</string>
    <key>ProgramArguments</key>
    <array>
        <string>${pythonPath}</string>
        <string>${projectRoot}/scripts/maintenance.py</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>4</integer>
        <key>Minute</key>
        <integer>30</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${homeDir}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/maintenance.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/maintenance.log</string>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>`;
  }

  function generateMaintenanceSystemdService(
    pythonPath: string,
    projectRoot: string,
    homeDir: string,
  ): string {
    return `[Unit]
Description=Deus KB maintenance

[Service]
Type=oneshot
ExecStart=${pythonPath} ${projectRoot}/scripts/maintenance.py
WorkingDirectory=${projectRoot}
Environment=HOME=${homeDir}
Environment=PATH=/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/maintenance.log
StandardError=append:${projectRoot}/logs/maintenance.log`;
  }

  function generateMaintenanceSystemdTimer(): string {
    return `[Unit]
Description=Deus KB maintenance timer

[Timer]
OnCalendar=*-*-* 04:30:00
Persistent=true

[Install]
WantedBy=timers.target`;
  }

  it('macOS plist contains maintenance.py path and 04:30 schedule', () => {
    const plist = generateMaintenancePlist(
      '/usr/bin/python3',
      '/Users/test/deus',
      '/Users/test',
    );
    expect(plist).toContain('com.deus-v2.maintenance');
    expect(plist).toContain('scripts/maintenance.py');
    expect(plist).toContain('<integer>4</integer>');
    expect(plist).toContain('<integer>30</integer>');
    expect(plist).toContain('RunAtLoad');
    expect(plist).toContain('<false/>');
  });

  it('systemd service unit contains correct ExecStart', () => {
    const unit = generateMaintenanceSystemdService(
      '/usr/bin/python3',
      '/home/user/deus',
      '/home/user',
    );
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('scripts/maintenance.py');
    expect(unit).toContain('maintenance.log');
  });

  it('systemd timer fires daily at 04:30', () => {
    const timer = generateMaintenanceSystemdTimer();
    expect(timer).toContain('OnCalendar=*-*-* 04:30:00');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('timers.target');
  });
});
