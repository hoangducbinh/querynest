export const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
