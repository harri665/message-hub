import { useState } from 'react';
import { initials } from '../format.ts';

/**
 * A person's or group's circle: their photo when the hub has one (`version` is the photo's version from the thread
 * list, which makes the URL cacheable forever), otherwise their initials.
 */
export function Avatar({ tid, title, isGroup, version, small }: { tid: string; title: string; isGroup: boolean; version?: string | null; small?: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const showPhoto = !!version && failed !== version;
  return (
    <span className={`avatar ${small ? 'small' : ''} ${isGroup ? 'group' : ''} ${showPhoto ? 'photo' : ''}`} aria-hidden="true">
      {showPhoto ? (
        <img
          src={`/api/avatars/${tid}?w=128&v=${version}`}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(version)}
        />
      ) : (
        initials(title)
      )}
    </span>
  );
}
