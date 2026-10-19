import { describe, expect, it } from "vitest";
import { configureConductorSettings, restoreConductorSettings, parseConductorSettingsBackup } from "../../src/setup/conductor-settings.js";

const wrapper="/Users/test/.opper/conductor/codex";
describe("Conductor settings",()=>{
  it("creates the Codex CLI pair and removes an otherwise empty new file",()=>{
    const prepared=configureConductorSettings(null,wrapper);
    expect(parseConductorSettingsBackup(JSON.stringify(prepared.backup))).toEqual(prepared.backup);
    expect(prepared.text).toContain('codex_provider = "default"');expect(prepared.text).toContain(`codex_executable_path = "${wrapper}"`);
    expect(restoreConductorSettings(prepared.text,prepared.backup)).toBe(null);
  });
  it("restores original literals, formatting and unrelated settings without backing them up",()=>{
    const original="# personal settings\ncodex_provider = 'custom' # provider\ncodex_executable_path = '/my/codex'\nprivate_token = 'do-not-back-up'\n[unrelated]\ncolor = 'blue'\n";
    const prepared=configureConductorSettings(original,wrapper);
    expect(JSON.stringify(prepared.backup)).not.toContain("do-not-back-up");
    expect(restoreConductorSettings(prepared.text,prepared.backup)).toBe(original);
    expect(restoreConductorSettings(prepared.text+"# new comment\n",prepared.backup)).toBe(original+"# new comment\n");
  });
  it("retains the original backup across reconfiguration and preserves an originally empty file",()=>{
    const first=configureConductorSettings("",wrapper);const next=configureConductorSettings(first.text,wrapper,first.backup);
    expect(next.backup).toEqual(first.backup);expect(restoreConductorSettings(next.text,next.backup)).toBe("");
  });
  it("preserves user content added to a newly created file",()=>{
    const prepared=configureConductorSettings(null,wrapper);
    expect(restoreConductorSettings(prepared.text+"theme = 'dark'\n",prepared.backup)).toBe("theme = 'dark'\n");
  });
  it("refuses to overwrite independently changed managed values",()=>{
    const prepared=configureConductorSettings(null,wrapper);const edited=prepared.text.replace('"default"','"custom"');
    expect(()=>configureConductorSettings(edited,wrapper,prepared.backup)).toThrow(/changed/);
    expect(()=>restoreConductorSettings(edited,prepared.backup)).toThrow(/changed/);
    const other=prepared.text.replace(wrapper,"/other/codex");expect(restoreConductorSettings(other,prepared.backup)).toBe(other);
  });
  it("normalizes a legacy manual wrapper path so removal cannot restore a dead executable",()=>{
    const prepared=configureConductorSettings(`codex_provider = 'default'\ncodex_executable_path = '${wrapper}'\n`,wrapper);
    expect(restoreConductorSettings(prepared.text,prepared.backup)).toBe("codex_provider = 'default'\n");
  });
  it("rejects malformed TOML, non-string managed fields, and invalid narrow backups",()=>{
    expect(()=>configureConductorSettings("bad = [",wrapper)).toThrow(/TOML/);
    expect(()=>configureConductorSettings("codex_provider = 42",wrapper)).toThrow(/string/);
    const prepared=configureConductorSettings(null,wrapper);
    expect(()=>parseConductorSettingsBackup(JSON.stringify({...prepared.backup,values:{...prepared.backup.values,codex_provider:"42"}}))).toThrow(/backup/);
    expect(()=>parseConductorSettingsBackup(JSON.stringify({...prepared.backup,private_token:"not-allowed"}))).toThrow(/backup/);
  });
});
