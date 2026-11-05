'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseMountinfo, baseDevice, isRemovable, hostStorage, containerStorage } = require('../src/health/storage');

const MOUNTINFO = [
  '22 1 179:2 / / rw,relatime - ext4 /dev/mmcblk0p2 rw',
  '23 22 0:5 / /proc rw - proc proc rw',
  '30 22 8:1 /gatecontrol /cache rw,relatime - ext4 /dev/sda1 rw',
  '31 22 8:1 /docker/containers/x/hosts /etc/hosts rw - ext4 /dev/sda1 rw',
  '32 22 0:40 / /state rw - overlay overlay rw',
  '33 22 8:17 / /mnt/usb\\040disk rw - exfat /dev/sdb1 rw',
  '34 22 259:1 / /data rw - btrfs /dev/nvme0n1p1 rw',
  '35 22 8:1 /gatecontrol /cache rw - ext4 /dev/sda1 rw',
].join('\n');

describe('telemetry: storage', () => {
  it('parses mountinfo: real block filesystems only, unescapes, dedups', () => {
    assert.deepEqual(parseMountinfo(MOUNTINFO), [
      { mount: '/', fs: 'ext4', source: '/dev/mmcblk0p2' },
      { mount: '/cache', fs: 'ext4', source: '/dev/sda1' },
      { mount: '/mnt/usb disk', fs: 'exfat', source: '/dev/sdb1' },
      { mount: '/data', fs: 'btrfs', source: '/dev/nvme0n1p1' },
    ]);
  });

  it('base devices and removable detection (USB path or removable flag; SD card never)', () => {
    assert.equal(baseDevice('/dev/sda1'), 'sda');
    assert.equal(baseDevice('/dev/mmcblk0p2'), 'mmcblk0');
    assert.equal(baseDevice('/dev/nvme0n1p1'), 'nvme0n1');
    const io = (removable, real) => ({ readFile: () => removable, realpath: () => real });
    assert.equal(isRemovable('/dev/sda1', io('0\n', '/sys/devices/platform/scb/fd500000.pcie/usb2/2-1/host0/block/sda')), true);
    assert.equal(isRemovable('/dev/sdb1', io('1\n', '/sys/devices/x')), true);
    assert.equal(isRemovable('/dev/nvme0n1p1', io('0\n', '/sys/devices/pci0000:00/nvme')), false);
    assert.equal(isRemovable('/dev/mmcblk0p2', io('1\n', '/x/usb')), false);
  });

  it('containerStorage uses statfs; host entries are sanitised', () => {
    const out = containerStorage({
      readFile: (f) => (f === '/proc/self/mountinfo' ? MOUNTINFO : f.includes('/sdb/') ? '1' : '0'),
      statfs: (m) => ({ blocks: m === '/' ? 100 : 1000, bsize: 4096, bavail: 10 }),
      stat: () => ({ isDirectory: () => true }),
      realpath: (p) => (p.endsWith('sda') ? '/sys/devices/usb1/sda' : '/sys/devices/x'),
    });
    assert.deepEqual(out.map((s) => [s.mount, s.removable, s.sizeBytes]), [['/', false, 409600], ['/cache', true, 4096000], ['/mnt/usb disk', true, 4096000], ['/data', false, 4096000]]);
    assert.equal(out[0].origin, 'container');
    assert.deepEqual(hostStorage({ disks: [{ mount: '/media/usb', fs: 'ext4', sizeBytes: 5, freeBytes: -1, removable: true }, { mount: 'relative' }, null] }),
      [{ mount: '/media/usb', fs: 'ext4', sizeBytes: 5, freeBytes: null, removable: true, origin: 'host' }]);
    assert.deepEqual(hostStorage(null), []);
  });
});
