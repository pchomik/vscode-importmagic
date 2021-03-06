const PREFIX = 'Python Importmagic: ';

export class Logger {
    public logError(message: string, ex?: Error) {
        console.error(`${PREFIX}${message}`, error);
    }
    public logWarning(message: string, ex?: Error) {
        console.warn(`${PREFIX}${message}`, ex);
    }
}
// tslint:disable-next-line:no-any
export function error(title: string = '', message: any) {
    new Logger().logError(`${title}, ${message}`);
}
// tslint:disable-next-line:no-any
export function warn(title: string = '', message: any) {
    new Logger().logWarning(`${title}, ${message}`);
}
