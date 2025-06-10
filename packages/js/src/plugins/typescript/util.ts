import { readJsonFile, type TargetConfiguration } from '@nx/devkit';
import { existsSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { type PackageManagerCommands } from 'nx/src/utils/package-manager';
import { join } from 'path';
import { type ParsedCommandLine } from 'typescript';
import picomatch = require('picomatch');

export type ExtendedConfigFile = {
  filePath: string;
  externalPackage?: string;
};
export type ParsedTsconfigData = Pick<
  ParsedCommandLine,
  'options' | 'projectReferences' | 'raw'
> & {
  extendedConfigFiles: ExtendedConfigFile[];
};

/**
 * Allow uses that use incremental builds to run `nx watch-deps` to continuously build all dependencies.
 */
export function addBuildAndWatchDepsTargets(
  workspaceRoot: string,
  projectRoot: string,
  targets: Record<string, TargetConfiguration>,
  options: { buildDepsTargetName?: string; watchDepsTargetName?: string },
  pmc: PackageManagerCommands
): void {
  let projectName: string;

  const projectJsonPath = join(workspaceRoot, projectRoot, 'project.json');
  const packageJsonPath = join(workspaceRoot, projectRoot, 'package.json');

  if (existsSync(projectJsonPath)) {
    const projectJson = readJsonFile(projectJsonPath);
    projectName = projectJson.name;
  } else if (existsSync(packageJsonPath)) {
    const packageJson = readJsonFile(packageJsonPath);
    projectName = packageJson.nx?.name ?? packageJson.name;
  }

  if (!projectName) return;

  if (projectName) {
    const buildDepsTargetName = options.buildDepsTargetName ?? 'build-deps';
    targets[buildDepsTargetName] = {
      dependsOn: ['^build'],
    };
    targets[options.watchDepsTargetName ?? 'watch-deps'] = {
      continuous: true,
      dependsOn: [buildDepsTargetName],
      command: `${pmc.exec} nx watch --projects ${projectName} --includeDependentProjects -- ${pmc.exec} nx ${buildDepsTargetName} ${projectName}`,
    };
  }
}

export function isValidPackageJsonBuildConfig(
  tsConfig: ParsedTsconfigData,
  workspaceRoot: string,
  projectRoot: string
): boolean {
  const resolvedProjectPath = isAbsolute(projectRoot)
    ? relative(workspaceRoot, projectRoot)
    : projectRoot;
  const packageJsonPath = join(
    workspaceRoot,
    resolvedProjectPath,
    'package.json'
  );
  if (!existsSync(packageJsonPath)) {
    // If the package.json file does not exist.
    // Assume it's valid because it would be using `project.json` instead.
    return true;
  }
  const packageJson = readJsonFile(packageJsonPath);



  // A path provided from either `exports` or `main`/`module` fields in package.json
  // is considered a source file if it matches the include patterns in tsconfig
  // or if it has a ts source file extension.
  const isPathSourceFile = (path: string): boolean => {
    let pathToCheck: string;
    if (isAbsolute(path)) {
      const pathWithoutLeadingSlash = path.startsWith('/')
        ? path.slice(1)
        : path;
      pathToCheck = resolve(workspaceRoot, pathWithoutLeadingSlash);
    } else {
      pathToCheck = resolve(workspaceRoot, resolvedProjectPath, path);
    }

    const sourceExtensions = ['.ts', '.tsx', '.cts', '.mts'];

    const include = tsConfig.raw?.include;
    if (include && Array.isArray(include)) {
      const projectAbsolutePath = resolve(workspaceRoot, resolvedProjectPath);
      const relativeToProject = relative(projectAbsolutePath, pathToCheck);

      for (const pattern of include) {
        if (picomatch(pattern)(relativeToProject)) {
          return true;
        }
      }

      return false;
    }

    // Fallback to checking the extension if no include patterns are defined.
    const ext = extname(path);
    return sourceExtensions.includes(ext);
  };

  const containsInvalidPath = (
    value: string | Record<string, string>
  ): boolean => {
    if (typeof value === 'string') {
      return isPathSourceFile(value);
    } else if (typeof value === 'object') {
      return Object.entries(value).some(([currentKey, subValue]) => {
        // Skip types and development conditions
        if (currentKey === 'types' || currentKey === 'development') {
          return false;
        }
        if (typeof subValue === 'string') {
          return isPathSourceFile(subValue);
        }
        return false;
      });
    }
    return false;
  };

  const exports = packageJson?.exports;

  // Check the `.` export if `exports` is defined.
  if (exports) {
    if (typeof exports === 'string') {
      return !isPathSourceFile(exports);
    }
    if (typeof exports === 'object' && '.' in exports) {
      return !containsInvalidPath(exports['.']);
    }

    // Check other exports if `.` is not defined or valid.
    for (const key in exports) {
      if (key !== '.' && containsInvalidPath(exports[key])) {
        return false;
      }
    }

    return true;
  }

  // If `exports` is not defined, fallback to `main` and `module` fields.
  const buildPaths = ['main', 'module'];
  for (const field of buildPaths) {
    if (packageJson[field] && isPathSourceFile(packageJson[field])) {
      return false;
    }
  }

  return true;
}
