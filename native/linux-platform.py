#!/usr/bin/python3
"""LinuxPlay's binary iAP2 bridge. stdout is reserved for protocol bytes.

Uses Linux AF_BLUETOOTH sockets, including a bounded SDP query for the same
CarPlay service UUID used by WinPlay and MacPlay. No fixed RFCOMM channel or
root-owned /dev/rfcomm device is needed.
"""
import json
import os
import re
import threading
import socket
import struct
import subprocess
import sys
import uuid

SERVICE = uuid.UUID('00000000-deca-fade-deca-deafdecacafe').bytes
MAC = re.compile(r'^[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}$')


def element(data, offset=0, depth=0):
    """Decode the SDP Data Element subset, retaining the UUID type."""
    if depth > 16 or offset >= len(data):
        raise ValueError('SDP数据元素无效')
    header = data[offset]
    kind, size_index = header >> 3, header & 7
    offset += 1
    if size_index < 5:
        length = 0 if kind == 0 else 1 << size_index
    else:
        count = 1 << (size_index - 5)
        if offset + count > len(data):
            raise ValueError('SDP数据长度无效')
        length = int.from_bytes(data[offset:offset + count], 'big')
        offset += count
    end = offset + length
    if end > len(data):
        raise ValueError('SDP数据被截断')
    raw = data[offset:end]
    if kind in (6, 7):
        value = []
        while offset < end:
            item, offset = element(data, offset, depth + 1)
            value.append(item)
        if offset != end:
            raise ValueError('SDP序列越界')
    elif kind == 3:
        value = ('uuid', int.from_bytes(raw, 'big'))
    elif kind in (1, 2):
        value = int.from_bytes(raw, 'big', signed=kind == 2)
    else:
        value = raw
    return value, end


def rfcomm_channel(attributes):
    records, end = element(attributes)
    if end != len(attributes) or not isinstance(records, list):
        raise ValueError('SDP服务响应无效')
    for record in records:
        if not isinstance(record, list):
            continue
        for index in range(0, len(record) - 1, 2):
            if record[index] != 4 or not isinstance(record[index + 1], list):
                continue
            for protocol in record[index + 1]:
                if (isinstance(protocol, list) and len(protocol) >= 2
                        and protocol[0] == ('uuid', 3)
                        and isinstance(protocol[1], int) and 1 <= protocol[1] <= 30):
                    return protocol[1]
    raise RuntimeError('iPhone未公布CarPlay蓝牙服务，请解锁手机并确认两端蓝牙配对')


def discover_channel(address, create_socket=socket.socket):
    # ServiceSearchAttributeRequest: UUID128 + ProtocolDescriptorList(0x0004).
    request = b'\x35\x11\x1c' + SERVICE + b'\xff\xff\x35\x03\x09\x00\x04'
    attributes = bytearray()
    continuation = b''
    with create_socket(socket.AF_BLUETOOTH, socket.SOCK_SEQPACKET,
                       socket.BTPROTO_L2CAP) as channel:
        channel.settimeout(12)
        channel.connect((address, 1))
        for transaction in range(1, 33):
            params = request + bytes([len(continuation)]) + continuation
            channel.sendall(struct.pack('!BHH', 6, transaction, len(params)) + params)
            response = channel.recv(65540)
            if len(response) < 5:
                raise ValueError('SDP响应过短')
            kind, reply_id, length = struct.unpack('!BHH', response[:5])
            if reply_id != transaction or length != len(response) - 5:
                raise ValueError('SDP响应标识或长度无效')
            if kind == 1:
                raise RuntimeError('iPhone拒绝CarPlay蓝牙服务查询')
            if kind != 7 or length < 3:
                raise ValueError('SDP响应类型无效')
            count = int.from_bytes(response[5:7], 'big')
            boundary = 7 + count
            if boundary >= len(response):
                raise ValueError('SDP属性长度无效')
            attributes.extend(response[7:boundary])
            continuation_length = response[boundary]
            if continuation_length > 16 or boundary + 1 + continuation_length != len(response):
                raise ValueError('SDP续传状态无效')
            continuation = response[boundary + 1:]
            if len(attributes) > 1024 * 1024:
                raise ValueError('SDP响应过大')
            if not continuation:
                return rfcomm_channel(attributes)
    raise RuntimeError('SDP服务查询续传次数过多')


def paired_devices():
    def run(*args):
        result = subprocess.run(['bluetoothctl', '--timeout', '5', *args],
                                capture_output=True, text=True, timeout=8,
                                env={**os.environ, 'LC_ALL': 'C'})
        if result.returncode:
            raise RuntimeError('无法访问BlueZ，请开启蓝牙并检查bluetooth服务')
        return re.sub(r'\x1b\[[0-9;]*[A-Za-z]', '', result.stdout)
    info = run('show')
    adapter = re.search(r'^Controller ([0-9A-Fa-f:]{17}) ', info, re.M)
    if not adapter:
        raise RuntimeError('Linux未检测到可用蓝牙适配器，请开启蓝牙')
    if not re.search(r'^\s*Powered:\s*yes\s*$', info, re.M):
        raise RuntimeError('蓝牙尚未开启，请在系统蓝牙设置中开启蓝牙')
    paired = run('devices', 'Paired')
    if re.search(r'Invalid command|Unknown command|Invalid argument', paired):
        paired = run('paired-devices')
    if re.search(r'Invalid command|Unknown command|Invalid argument|Failed|not available', paired):
        raise RuntimeError('无法读取已配对蓝牙设备，请检查BlueZ服务')
    devices = [{'address': item[0].upper(), 'name': item[1]}
               for item in re.findall(r'^Device ([0-9A-Fa-f:]{17}) (.+)$',
                                      paired, re.M)]
    return {'adapter': adapter[1].upper(), 'devices': devices}


def bridge(address):
    if not MAC.fullmatch(address):
        raise ValueError('蓝牙地址格式无效')
    channel_number = discover_channel(address)
    with socket.socket(socket.AF_BLUETOOTH, socket.SOCK_STREAM,
                       socket.BTPROTO_RFCOMM) as channel:
        channel.settimeout(15)
        channel.connect((address, channel_number))
        channel.settimeout(None)
        relay(channel)


def relay(channel, input_fd=0, output=None):
    # Independent TX/RX preserves full duplex under socket or pipe backpressure.
    output = sys.stdout.buffer if output is None else output
    finished = threading.Event()
    transmit_errors = []

    def transmit():
        try:
            while not finished.is_set():
                data = os.read(input_fd, 65536)
                if not data:
                    break
                channel.sendall(data)
        except OSError as error:
            if not finished.is_set():
                transmit_errors.append(error)
        finally:
            finished.set()
            try:
                channel.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    worker = threading.Thread(target=transmit, daemon=True)
    worker.start()
    try:
        while True:
            try:
                data = channel.recv(65536)
            except OSError:
                if finished.is_set():
                    break
                raise
            if not data:
                break
            output.write(data)
            output.flush()
    finally:
        finished.set()
        try:
            channel.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    if transmit_errors:
        raise transmit_errors[0]



def main():
    if len(sys.argv) == 2 and sys.argv[1] == 'list':
        print(json.dumps(paired_devices(), ensure_ascii=False))
    elif len(sys.argv) == 3 and sys.argv[1] == 'bluetooth':
        bridge(sys.argv[2])
    else:
        raise ValueError('Linux平台桥参数无效')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print('Linux蓝牙桥接失败：' + str(error), file=sys.stderr)
        sys.exit(1)
