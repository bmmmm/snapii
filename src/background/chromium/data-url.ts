// SPDX-License-Identifier: GPL-3.0-or-later

/** FileReader exists in a service worker, URL.createObjectURL does not (C1 in src/shared/spike.ts). */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("could not read the blob"));
    reader.readAsDataURL(blob);
  });
}
