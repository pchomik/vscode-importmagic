import { PythonSettings } from './../common/configSettings';
import { ProcessService } from './../common/proc';
import { ICommandResult } from './importMagicProxy';
import * as logger from '../common/logger';
import * as path from 'path';
import * as vscode from 'vscode';
import { ChildProcess } from 'child_process';
import { createDeferred, Deferred } from '../common/helpers';
import { debounce } from '../common/decorators';
import { isTestExecution } from '../common/utils';

export enum MethodType {
    BuildIndex = 'build_index',
    Suggestions = 'import_suggestions',
    Import = 'insert_import',
    RemoveUnusedImports = 'remove_unused_imports',
    Symbols = 'get_symbols'
}

export interface ICommandResult {
    requestId?: number;
}

interface IResultBuild extends ICommandResult {
    success: boolean;
}

export interface ISuggestionItem {
    score: number;
    module: string;
    variable?: string;
}

export interface IResultSuggestions extends ICommandResult {
    candidates: ISuggestionItem[];
}

export interface ISuggestionSymbol {
    key: string;
    score: number;
    module: string;
    variable?: string;
    depth: number;
}

export interface IResultSymbols extends ICommandResult {
    items: ISuggestionSymbol[];
}

export interface IResultImport extends ICommandResult {
    fromLine: number;
    endLine: number;
    text: string;
}

export interface IResultRemoveUnusedImports extends ICommandResult {
    fromLine: number;
    endLine: number;
    text: string;
}

interface IResultError extends ICommandResult {
    error: boolean;
    message: string;
    traceback: string;
    type: string;
}

export interface ICommand<T extends ICommandResult> {
    method: MethodType;
    deferred?: Deferred<T>;
    commandId?: number;
    text?: string;
}

interface ICommandBuild<T extends ICommandResult> extends ICommand<T> {
    workspacePath: string;
    extraPaths: string[];
    skipTestFolders: boolean;
}

export interface ICommandSuggestions<T extends ICommandResult> extends ICommand<T> {
    sourceFile: string;
    unresolvedName: string;
}

export interface ICommandSymbols<T extends ICommandResult> extends ICommand<T> {
    text: string;
}

export interface ICommandImport<T extends ICommandResult> extends ICommand<T> {
    sourceFile: string;
    module: string;
    variable?: string;
}

export interface ICommandRemoveUnusedImports<T extends ICommandResult> extends ICommand<T> {
    sourceFile: string;
}

export class ImportMagicProxy {
    private pythonSettings: PythonSettings;
    private workspacePath: string;

    private proc: ChildProcess | null;
    private previousData = '';

    private languageServerStarted: Deferred<void>;
    private commands = new Map<number, ICommand<ICommandResult>>();
    private commandId: number = 0;
    private restartAttempts: number = 0;
    private progressPromise: Promise<object> | null = null;

    constructor(private extensionRootDir: string, workspacePath: string) {
        this.workspacePath = workspacePath;
        this.pythonSettings = PythonSettings.getInstance(vscode.Uri.file(workspacePath));
        this.pythonSettings.on('change', () => this.onChangeSettings());

        this.restartServer();
    }

    private static getProperty<T>(o: object, name: string): T {
        return <T>o[name];
    }

    public dispose() {
        this.killProcess();
    }

    public async sendCommand<T extends ICommandResult>(cmd: ICommand<T>): Promise<T> {
        await this.languageServerStarted.promise;
        return this.sendRequest(cmd);
    }

    @debounce(30000)
    public async buildIndex() {
        const isTest = isTestExecution();

        const cmd: ICommandBuild<IResultBuild> = {
            method: MethodType.BuildIndex,
            workspacePath: this.workspacePath,
            extraPaths: this.getExtraPaths(),
            skipTestFolders: !isTest
        };

        await this.sendRequest(cmd);
    }

    private onChangeSettings() {
        this.restartAttempts = 0;
        this.restartServer();
    }

    private restartServer() {
        this.languageServerStarted = createDeferred<void>();
        this.killProcess();
        this.clearPendingRequests();
        this.spawnProcess();
    }

    private async spawnProcess() {
        this.restartAttempts += 1;
        const cwd: string = path.join(this.extensionRootDir, 'pythonFiles');
        const pythonProcess = new ProcessService();

        const pythonPath = this.pythonSettings.pythonPath;
        const args = ['importMagic.py'];
        const result = pythonProcess.execObservable(pythonPath, args, { cwd });
        this.proc = result.proc;

        if (!result.proc.pid) {
            this.languageServerStarted.reject({message: 'Importmagic: Python interpreter not found'});
            return false;
        }

        result.proc.on('end', (end) => {
            logger.error('spawnProcess.end', `End - ${end}`);
        });
        result.proc.on('error', error => {
            logger.error('Error', `${error}`);
        });
        result.out.subscribe(output => {
            const data = output.out;
            const dataStr = this.previousData = `${this.previousData}${data}`;

            if (dataStr.endsWith('\n')) {
                this.previousData = '';
                this.onData(dataStr);
            }
        });

        await this.buildIndex();
        this.languageServerStarted.resolve();
    }

    private killProcess() {
        try {
            if (this.proc) {
                this.proc.kill();
            }
        // tslint:disable-next-line:no-empty
        } catch { }
        this.proc = null;
    }

    private getExtraPaths() {
        // Add support for paths relative to workspace.
        return this.pythonSettings.extraPaths.map(extraPath => {
            if (path.isAbsolute(extraPath)) {
                return extraPath;
            }
            if (typeof this.workspacePath !== 'string') {
                return '';
            }
            return path.join(this.workspacePath, extraPath);
        });
    }

    private sendRequest<T extends ICommandResult>(cmd: ICommand<T>): Promise<T> {
        this.commandId += 1;

        const extendedPayload = {
            requestId: this.commandId,
            ...cmd
        };

        const executionCmd = cmd;
        executionCmd.deferred = createDeferred<T>();
        executionCmd.commandId = this.commandId;

        try {
            if (!this.proc) {
                throw new Error('ImportMagic process is die');
            }

            this.proc.stdin.write(`${JSON.stringify(extendedPayload)}\n`);
            this.commands.set(this.commandId, executionCmd);
            this.updateProgress();
        }catch (ex) {
            logger.error('ImportMagicProxy', `Error "${ex.message}"`);
            if (this.restartAttempts < 10) {
                this.restartServer();
                return Promise.reject('ImportMagic process will be restarted. Try run command again');
            } else {
                return Promise.reject('ImportMagic can not start the process');
            }
        }
        return executionCmd.deferred.promise;
    }

    private clearPendingRequests() {
        this.commands.forEach(item => {
            if (item.deferred !== undefined) {
                item.deferred.reject();
            }
        });
        this.commands.clear();
        this.updateProgress();
    }

    private onData(dataStr: string) {
        try{
            const response = JSON.parse(dataStr);
            const responseId = ImportMagicProxy.getProperty<number>(response, 'id');

            if (!responseId) {
                logger.error('ImportMagicProxy', 'Response not contain id');
                return;
            }

            const cmd = this.commands.get(responseId);
            if (!cmd) {
                return;
            }
            this.commands.delete(responseId);
            this.updateProgress();

            if (response.error) {
                logger.error('ImportMagicProxy', `Error from process: ${response.message}`);
            }

            const isError: boolean = response.error ? true : false;
            const handler = isError ? this.onError : this.getCommandHandler(cmd.method);
            if (!handler) {
                return;
            }

            const result = handler.call(this, cmd, response);

            if (cmd && cmd.deferred) {
                if (isError) {
                    cmd.deferred.reject(result);
                } else {
                    cmd.deferred.resolve(result);
                }
            }
            // tslint:disable-next-line:no-empty
        } catch { }
    }

    private getCommandHandler(command: MethodType): undefined | ((command: ICommand<ICommandResult>, response: object) => ICommandResult) {
        switch (command) {
            case MethodType.BuildIndex:
                return this.onBuild;
            case MethodType.Suggestions:
                return this.onSuggestions;
            case MethodType.Import:
                return this.onImport;
            case MethodType.RemoveUnusedImports:
                return this.onRemoveUnusedImports;
            case MethodType.Symbols:
                return this.onSymbols;
            default:
                return;
        }
    }

    private onError(command: ICommand<ICommandResult>, response: object): IResultError {
        return {
            requestId: command.commandId,
            error: true,
            message: ImportMagicProxy.getProperty<string>(response, 'message'),
            traceback: ImportMagicProxy.getProperty<string>(response, 'traceback'),
            type: ImportMagicProxy.getProperty<string>(response, 'type')
        };
    }

    private updateProgress() {
        if (this.progressPromise !== null) {
            return;
        }

        const title = 'ImportMagic: progress';
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: title}, p => {
            this.progressPromise = new Promise((resolve, reject) => {
                const handle = setInterval(() => {
                    const value = this.commands.size;
                    // const plural = value > 1 ? 's' : '';
                    // p.report({message: `${title} (${value} task${plural})` });
                    if (value === 0) {
                        clearInterval(handle);
                        resolve();
                        this.progressPromise = null;
                    }
                }, 500);
            });
            return this.progressPromise;
        });
    }

    private onBuild(command: ICommand<ICommandResult>, response: object): IResultBuild {
        return {
            requestId: command.commandId,
            success: ImportMagicProxy.getProperty<boolean>(response, 'success')
        };
    }

    private onSuggestions(command: ICommand<ICommandResult>, response: object): IResultSuggestions {
        let candidates = ImportMagicProxy.getProperty<object[]>(response, 'candidates');

        candidates = Array.isArray(candidates) ? candidates : [];

        const suggestionItems: ISuggestionItem[] = candidates.map(item => {
            return {
                score: (ImportMagicProxy.getProperty<number>(item, 'score') || 0),
                module: ImportMagicProxy.getProperty<string>(item, 'module'),
                variable: ImportMagicProxy.getProperty<string>(item, 'variable') || undefined
            };
        });

        return {
            requestId: command.commandId,
            candidates: suggestionItems
        };
    }

    private onImport(command: ICommand<ICommandResult>, response: object): IResultImport {
        return {
            requestId: command.commandId,
            fromLine: ImportMagicProxy.getProperty<number>(response, 'fromLine'),
            endLine: ImportMagicProxy.getProperty<number>(response, 'endLine'),
            text: ImportMagicProxy.getProperty<string>(response, 'text') || ''
        };
    }

    private onRemoveUnusedImports(command: ICommand<ICommandResult>, response: object): IResultRemoveUnusedImports {
        return {
            requestId: command.commandId,
            fromLine: ImportMagicProxy.getProperty<number>(response, 'fromLine'),
            endLine: ImportMagicProxy.getProperty<number>(response, 'endLine'),
            text: ImportMagicProxy.getProperty<string>(response, 'text') || ''
        };
    }

    private onSymbols(command: ICommand<ICommandResult>, response: object): IResultSymbols {
        let items = ImportMagicProxy.getProperty<object[]>(response, 'items');
        items = Array.isArray(items) ? items : [];

        const suggestionItems: ISuggestionSymbol[] = items.map(item => {
            return {
                key: ImportMagicProxy.getProperty<string>(item, 'key'),
                module: ImportMagicProxy.getProperty<string>(item, 'module'),
                variable: ImportMagicProxy.getProperty<string>(item, 'variable') || undefined,
                depth: ImportMagicProxy.getProperty<number>(item, 'depth'),
                score: ImportMagicProxy.getProperty<number>(item, 'score') || 0
            };
        });
        return {
            requestId: command.commandId,
            items: suggestionItems
        };
    }
}
