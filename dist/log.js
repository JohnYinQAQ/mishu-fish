function stamp() {
    return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
const color = process.stdout.isTTY;
function paint(code, text) {
    return color ? `\u001B[${code}m${text}\u001B[0m` : text;
}
export function info(message) {
    console.log(`${paint('90', stamp())} ${message}`);
}
export function ok(message) {
    console.log(`${paint('90', stamp())} ${paint('32', '✓')} ${message}`);
}
export function warn(message) {
    console.log(`${paint('90', stamp())} ${paint('33', '!')} ${message}`);
}
export function fail(message) {
    console.error(`${paint('90', stamp())} ${paint('31', '✗')} ${message}`);
}
/** 来自微信的消息 */
export function incoming(name, text) {
    console.log(`\n${paint('36', `← ${name}`)} ${text}`);
}
/** 秘书鱼发出的消息 */
export function outgoing(text) {
    console.log(`${paint('35', '→ 秘书鱼')} ${text}`);
}
