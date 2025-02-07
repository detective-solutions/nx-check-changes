import * as core from '@actions/core';
import { getInput, info, setFailed, setOutput } from '@actions/core';
import { context } from '@actions/github';
import { NxJson } from '@nrwl/workspace';
import { promises as fs } from 'fs';

import { exec } from './exec';
import { getAllFiles } from './utils';

interface Changes {
  apps: string[];
  libs: string[];
}

interface Refs {
  base: string;
  head: string;
}

const getBaseAndHeadRefs = ({ base, head }: Partial<Refs>): Refs => {
  if (!base && !head) {
    switch (context.eventName) {
      case 'pull_request':
        base = context.payload.pull_request?.base?.sha as string;
        head = context.payload.pull_request?.head?.sha as string;
        break;
      case 'push':
        base = context.payload.before as string;
        head = context.payload.after as string;
        break;
      default:
        throw new Error(`Unsupported event: ${context.eventName}`);
    }
  }

  if (!base || !head) {
    throw new Error(`Base or head refs are missing`);
  }

  info(`Event name: ${context.eventName}`);
  info(`Base ref: ${base}`);
  info(`Head ref: ${head}`);

  return {
    base,
    head
  };
};

const parseGitDiffOutput = (output: string): string[] => {
  const tokens = output.split('\u0000').filter(s => s.length > 0);
  const files: string[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    files.push(tokens[i + 1]);
  }
  return files;
};

const fixStdOutNullTermination = () => {
  // Previous command uses NULL as delimiters and output is printed to stdout.
  // We have to make sure next thing written to stdout will start on new line.
  // Otherwise things like ::set-output wouldn't work.
  core.info('');
};

const getChangedFiles = async (base: string, head: string): Promise<string[]> => {
  core.startGroup(`Detecting changes ${base}...${head}`);

  await exec('git', ['checkout', base]);
  await exec('git', ['checkout', head]);

  const stdout = (
    await exec('git', ['diff', '--no-renames', '--name-status', '-z', `${base}...${head}`])
  ).stdout;

  fixStdOutNullTermination();
  core.endGroup();

  return parseGitDiffOutput(stdout);
};

const readNxFile = async (): Promise<NxJson> => {
  const nxFile = await fs.readFile('nx.json', { encoding: 'utf-8' });
  return JSON.parse(nxFile) as NxJson;
};

const dirFinder = (dir: string): ((file: string) => string | undefined) => {
  const pathRegExp = new RegExp(`^${dir}/([^/]+)`);
  return (file: string) => file.match(pathRegExp)?.[1];
};

const getLibDependenciesPerApp = async (appsDir: string) => {
  const libDependenciesPerApp: { [key: string]: string[] } = {};
  const projectFilePaths = getAllFiles(appsDir).filter((fileName: string) =>
    fileName.endsWith('project.json')
  );
  if (!projectFilePaths || projectFilePaths.length === 0) {
    return libDependenciesPerApp;
  }

  for (const projectFilePath of projectFilePaths) {
    const projectFile = JSON.parse(await fs.readFile(projectFilePath, { encoding: 'utf-8' }));
    const appName = projectFile?.name;
    const libFolderDependencies = projectFile?.libFolderDependencies;
    if (appName && libFolderDependencies) {
      libDependenciesPerApp[appName] = libFolderDependencies;
    }
  }
  return libDependenciesPerApp;
};

const getChanges = async ({
  appsDir,
  libsDir,
  libDependenciesPerApp,
  changedFiles
}: {
  appsDir: string;
  libsDir: string;
  libDependenciesPerApp: { [key: string]: string[] };
  changedFiles: string[];
}): Promise<Changes> => {
  const findApp = dirFinder(appsDir);
  const findLib = dirFinder(libsDir);

  const changes = changedFiles.reduce<{
    apps: Set<string>;
    libs: Set<string>;
  }>(
    (accumulatedChanges, file) => {
      const app = findApp(file);
      if (app) {
        accumulatedChanges.apps.add(app);
      }
      const lib = findLib(file);
      if (lib) {
        accumulatedChanges.libs.add(lib);

        // Check if an app depends on a changed lib and add the app to the accumulatedChanges
        for (const [affectedApp, libDependencies] of Object.entries(libDependenciesPerApp)) {
          if (libDependencies.includes(lib)) {
            accumulatedChanges.apps.add(affectedApp);
          }
        }
      }
      return accumulatedChanges;
    },
    {
      apps: new Set<string>(),
      libs: new Set<string>()
    }
  );

  return {
    apps: [...changes.apps.values()],
    libs: [...changes.libs.values()]
  };
};

const main = async () => {
  const { base, head } = getBaseAndHeadRefs({
    base: getInput('baseRef'),
    head: getInput('headRef')
  });

  const changedFiles = await getChangedFiles(base, head);

  const nxFile = await readNxFile();
  const appsDir = nxFile.workspaceLayout?.appsDir || 'apps';
  const libsDir = nxFile.workspaceLayout?.libsDir || 'libs';

  const libDependenciesPerApp = await getLibDependenciesPerApp(appsDir);

  const changes = await getChanges({
    appsDir,
    libsDir,
    libDependenciesPerApp,
    changedFiles
  });

  console.log('');

  console.log('Changed apps:');
  console.log(changes.apps);

  console.log('Changed libs:');
  console.log(changes.libs);

  // Output stringified lists in order to be reused as dynamic matrix inputs for follow-up actions
  setOutput('changed-apps', JSON.stringify(changes.apps));
  setOutput('changed-libs', JSON.stringify(changes.libs));
  setOutput('changed-dirs', JSON.stringify([...changes.apps, ...changes.libs]));
  setOutput('not-affected', changes.apps.length === 0 && changes.libs.length === 0);
};

main().catch(error => setFailed(error));
