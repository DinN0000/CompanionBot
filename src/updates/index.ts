import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

interface UpdateInfo {
  current: string;
  latest: string;
  hasUpdate: boolean;
}

// 현재 버전 가져오기
export function getCurrentVersion(): string {
  // package.json에서 버전 읽기
  return require("../../package.json").version;
}

// npm에서 최신 버전 체크
export async function checkForUpdates(): Promise<UpdateInfo> {
  const current = getCurrentVersion();
  
  try {
    const { stdout } = await execAsync("npm view companionbot version");
    const latest = stdout.trim();
    
    return {
      current,
      latest,
      hasUpdate: latest !== current && compareVersions(latest, current) > 0
    };
  } catch {
    return { current, latest: current, hasUpdate: false };
  }
}

// 버전 비교 (간단한 semver)
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}
