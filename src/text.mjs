export function truncateText(value, maximum) {
    const text = String(value ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (text.length <= maximum) return text;
    return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
}
