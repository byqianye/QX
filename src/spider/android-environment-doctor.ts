import type { AndroidEnvironmentDoctorResult, WhpxStatus } from "./android-runtime-types.js";
import type { AndroidRuntimeCommandRunner } from "./android-runtime-process.js";

export interface AndroidEnvironmentDoctorOptions {
  emulatorPath?: string;
  commandRunner: AndroidRuntimeCommandRunner;
  env?: NodeJS.ProcessEnv;
}

/** Checks the host hypervisor without changing Windows features. */
export class AndroidEnvironmentDoctor {
  private readonly options: AndroidEnvironmentDoctorOptions;

  public constructor(options: AndroidEnvironmentDoctorOptions) {
    this.options = options;
  }

  public async check(): Promise<AndroidEnvironmentDoctorResult> {
    const emulatorPath = this.options.emulatorPath;
    if (!emulatorPath) {
      return {
        emulatorFound: false,
        whpx: "unknown",
        diagnostics: ["EMULATOR_NOT_FOUND"],
        message: "Android Emulator 尚未安装",
      };
    }
    try {
      const result = await this.options.commandRunner.run(emulatorPath, ["-accel-check"], {
        ...(this.options.env ? { env: this.options.env } : {}),
        timeoutMs: 15_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      const whpx = parseWhpxStatus(output, result.exitCode);
      const virtualizationDisabled = /(?:virtualization|hypervisor)[^\r\n]*(?:disabled|off|not enabled)/iu.test(output);
      return {
        emulatorFound: true,
        emulatorPath,
        whpx,
        diagnostics: whpx === "ready" ? [] : [virtualizationDisabled ? "ANDROID_VIRTUALIZATION_DISABLED" : "WHPX_NOT_READY"],
        message: whpx === "ready"
          ? "Windows Hypervisor Platform 可用"
          : virtualizationDisabled
            ? "当前 BIOS/UEFI 虚拟化未启用，请启用 Intel VT-x 或 AMD-V/SVM 后重试。"
            : "需要启用 Windows Hypervisor Platform 或 BIOS 虚拟化",
      };
    } catch (error) {
      return {
        emulatorFound: true,
        emulatorPath,
        whpx: "unknown",
        diagnostics: ["WHPX_CHECK_FAILED"],
        message: error instanceof Error ? error.message : "WHPX 检查失败",
      };
    }
  }

  public async enableWhpx(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error("ANDROID_RUNTIME_CONFIRMATION_REQUIRED");
    const powershellPath = this.options.env?.QX_ANDROID_POWERSHELL_PATH ?? "powershell.exe";
    const result = await this.options.commandRunner.run(powershellPath, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      "$argsList='/Online','/Enable-Feature','/FeatureName:HypervisorPlatform','/All','/NoRestart'; $dism=Join-Path $env:SystemRoot 'System32\\dism.exe'; $p=Start-Process -FilePath $dism -Verb RunAs -PassThru -ArgumentList $argsList; $p.WaitForExit(); exit $p.ExitCode",
    ], { ...(this.options.env ? { env: this.options.env } : {}), timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new Error(`WHPX_ENABLE_FAILED: ${result.stderr || result.stdout}`);
  }
}

export function parseWhpxStatus(output: string, exitCode: number): WhpxStatus {
  if (exitCode !== 0) return "missing";
  return /WHPX[^\r\n]*(?:installed|usable|available)/iu.test(output) || /WHPX\([^\r\n]+\)[^\r\n]*usable/iu.test(output)
    ? "ready"
    : /(?:usable|installed|available)/iu.test(output) && /(?:accel|hypervisor|AEHD|GVM|WHPX)/iu.test(output)
      ? "ready"
      : "missing";
}

export function whpxEnableCommand(): readonly string[] {
  return ["/Online", "/Enable-Feature", "/FeatureName:HypervisorPlatform", "/All", "/NoRestart"];
}
