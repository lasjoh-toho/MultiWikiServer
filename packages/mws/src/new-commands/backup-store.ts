import { BaseCommand, CommandInfo } from "@tiddlywiki/commander";
import { serverEvents } from "@tiddlywiki/events";
import { dist_resolve } from "@tiddlywiki/server";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { existsSync } from "fs";
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from "fs/promises";
import * as path from "path";

serverEvents.on("cli.register", (commands) => {
  commands[info.name] = { info, Command: BackupStoreCommand };
});

const info: CommandInfo = {
  name: "backup-store",
  description: "Create a consistent backup of the data folder, even while the server is running",
  arguments: [
    ["dest", "The folder to write the backup to. It must not exist or be empty."],
  ],
  options: [
    ["skip-passwords-key", "Do not include passwords.key in the backup. Save it separately in a secure location instead."],
    ["json", "Print the backup manifest as JSON on the last line of output."],
  ],
  getHelp() {
    return [
      "",
      "The backup contains everything needed to restore the data folder:",
      "- store/database.sqlite (an online copy made with VACUUM INTO)",
      "- store/files (attachments)",
      "- package.json and package-lock.json",
      "- tw5/versions.txt",
      "- passwords.key (unless --skip-passwords-key is given)",
      "",
      "A manifest is written to mws-backup.json in the backup folder.",
      "",
      "To restore, stop the server, copy the contents of the backup folder",
      "into an empty data folder, and run `npm ci` followed by `npx mws update-tiddlywiki`.",
    ].join("\n");
  },
};

export interface BackupManifest {
  format: 1;
  created: string;
  mwsVersion: string;
  wikiPath: string;
  includesPasswordsKey: boolean;
  files: string[];
}

export class BackupStoreCommand extends BaseCommand<[string], {
  "skip-passwords-key"?: boolean;
  "json"?: boolean;
}> {
  static info = info;

  // set in startup.ts, this command does not need the full server config
  wikiPath!: string;

  async execute() {
    const wikiPath = this.wikiPath;
    const dest = path.resolve(wikiPath, this.params[0]);
    const storePath = path.resolve(wikiPath, "store");
    const databasePath = path.resolve(storePath, "database.sqlite");

    if (!existsSync(databasePath))
      throw "No database found at " + databasePath;
    if (dest === wikiPath || dest.startsWith(storePath + path.sep) || dest === storePath)
      throw "The backup folder must not be the data folder or inside the store folder.";
    if (existsSync(dest) && (await readdir(dest)).length)
      throw "The backup folder already exists and is not empty: " + dest;

    await mkdir(path.resolve(dest, "store"), { recursive: true });

    const files: string[] = [];

    // VACUUM INTO writes a transactionally consistent copy of a live database,
    // so the server does not need to be stopped.
    const backupDb = path.resolve(dest, "store", "database.sqlite");
    const factory = new PrismaBetterSqlite3({ url: "file:" + databasePath });
    const adapter = await factory.connect();
    try {
      await adapter.executeRaw({
        sql: "VACUUM INTO ?",
        args: [backupDb],
        argTypes: [{ scalarType: "string", arity: "scalar" }],
      });
    } finally {
      await adapter.dispose();
    }
    files.push("store/database.sqlite");

    // attachments are content addressed and never change once written
    const filesFolder = path.resolve(storePath, "files");
    if (existsSync(filesFolder)) {
      await cp(filesFolder, path.resolve(dest, "store", "files"), { recursive: true });
      files.push("store/files");
    }

    const copyIfExists = async (rel: string) => {
      const src = path.resolve(wikiPath, rel);
      if (!existsSync(src)) return;
      await mkdir(path.dirname(path.resolve(dest, rel)), { recursive: true });
      await copyFile(src, path.resolve(dest, rel));
      files.push(rel.split(path.sep).join("/"));
    };

    await copyIfExists("package.json");
    await copyIfExists("package-lock.json");
    await copyIfExists(path.join("tw5", "versions.txt"));
    const includesPasswordsKey = !this.options["skip-passwords-key"];
    if (includesPasswordsKey) await copyIfExists("passwords.key");

    const mwsVersion = await readFile(dist_resolve("../package.json"), "utf8")
      .then(e => JSON.parse(e).version as string)
      .catch(() => "unknown");

    const manifest: BackupManifest = {
      format: 1,
      created: new Date().toISOString(),
      mwsVersion,
      wikiPath,
      includesPasswordsKey,
      files,
    };
    await writeFile(path.resolve(dest, "mws-backup.json"), JSON.stringify(manifest, null, 2));

    console.log("Backup written to " + dest);
    if (!includesPasswordsKey)
      console.log("passwords.key was NOT included. Without it, all passwords must be reset after a restore.");
    if (this.options.json) console.log(JSON.stringify(manifest));
  }
}
