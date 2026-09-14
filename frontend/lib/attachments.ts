import type { AttachmentInput } from './types';

export async function readAttachment(file: File | null): Promise<AttachmentInput | undefined> {
  if (!file?.size) return undefined;
  if (file.size > 2 * 1024 * 1024) throw new Error('Attachments must be no larger than 2 MB.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The attachment could not be read.'));
    reader.onload = () => resolve({ name: file.name, contentType: file.type || 'text/plain', contentBase64: String(reader.result).split(',')[1] });
    reader.readAsDataURL(file);
  });
}
export const attachmentAccept = '.pdf,.png,.jpg,.jpeg,.txt,.csv,.json';
