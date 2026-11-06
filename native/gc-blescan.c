/*
 * gc-blescan – passiver Bluetooth-LE-Scan für das GateControl-Gateway
 * (Phase 3c, Schritt 2 – docs/radio.md).
 *
 * Öffnet einen HCI-Raw-Socket (AF_BLUETOOTH, braucht das Host-Netz und
 * CAP_NET_RAW, zum Einschalten des Adapters CAP_NET_ADMIN), schaltet einen
 * PASSIVEN Scan ein (keine Scan-Requests, keine Verbindungen) und gibt jedes
 * Werbepaket mit 16-bit-Service-Daten (AD-Typ 0x16) als eine Zeile aus:
 *
 *   S ready <legacy|extended|shared> hci<N>     Scan läuft
 *   A <MAC> <Adresstyp> <RSSI> <Daten hex>      ein Werbepaket
 *   E <Schritt> <errno|HCI-Status>              Fehler (danach Ende, Code 2)
 *
 * Aufruf: gc-blescan [Adapter-Nummer]. SIGTERM/SIGINT: Scan aus, Ende.
 * Keine Abhängigkeiten (keine BlueZ-Header), statisch gebaut im Dockerfile.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#ifndef AF_BLUETOOTH
#define AF_BLUETOOTH 31
#endif
#define BTPROTO_HCI 1
#define SOL_HCI 0
#define HCI_FILTER 2
#define HCI_CHANNEL_RAW 0
#define HCIDEVUP _IOW('H', 201, int)

#define HCI_COMMAND_PKT 0x01
#define HCI_EVENT_PKT 0x04
#define EVT_CMD_COMPLETE 0x0E
#define EVT_CMD_STATUS 0x0F
#define EVT_LE_META 0x3E
#define LE_ADV_REPORT 0x02
#define LE_EXT_ADV_REPORT 0x0D

#define OGF_LE 0x08
#define OCF_SET_SCAN_PARAMS 0x000B
#define OCF_SET_SCAN_ENABLE 0x000C
#define OCF_SET_EXT_SCAN_PARAMS 0x0041
#define OCF_SET_EXT_SCAN_ENABLE 0x0042
#define HCI_CMD_DISALLOWED 0x0C

struct sockaddr_hci {
	sa_family_t hci_family;
	unsigned short hci_dev;
	unsigned short hci_channel;
};

struct hci_ufilter {
	uint32_t type_mask;
	uint32_t event_mask[2];
	uint16_t opcode;
};

static volatile sig_atomic_t stop_flag = 0;
static int mode_ext = 0;

static void on_signal(int sig) { (void)sig; stop_flag = 1; }

static uint16_t opcode(uint16_t ogf, uint16_t ocf) { return (uint16_t)((ogf << 10) | ocf); }

static int send_cmd(int fd, uint16_t ocf, const uint8_t *params, uint8_t plen)
{
	uint8_t buf[4 + 255];
	uint16_t op = opcode(OGF_LE, ocf);
	buf[0] = HCI_COMMAND_PKT;
	buf[1] = (uint8_t)(op & 0xFF);
	buf[2] = (uint8_t)(op >> 8);
	buf[3] = plen;
	if (plen) memcpy(buf + 4, params, plen);
	return write(fd, buf, 4u + plen) == (ssize_t)(4u + plen) ? 0 : -1;
}

/* Kommando senden und auf Command Complete/Status warten → HCI-Status (0 = gut), -1 = Zeitüberschreitung/Fehler. */
static int run_cmd(int fd, uint16_t ocf, const uint8_t *params, uint8_t plen)
{
	uint8_t buf[260];
	uint16_t want = opcode(OGF_LE, ocf);
	struct timespec t0, t1;
	if (send_cmd(fd, ocf, params, plen) < 0) return -1;
	clock_gettime(CLOCK_MONOTONIC, &t0);
	for (;;) {
		struct pollfd p = { .fd = fd, .events = POLLIN };
		clock_gettime(CLOCK_MONOTONIC, &t1);
		long ms = (t1.tv_sec - t0.tv_sec) * 1000L + (t1.tv_nsec - t0.tv_nsec) / 1000000L;
		if (ms >= 2000) return -1;
		int r = poll(&p, 1, (int)(2000 - ms));
		if (r <= 0) { if (r < 0 && errno == EINTR) continue; return -1; }
		ssize_t n = read(fd, buf, sizeof(buf));
		if (n < 3 || buf[0] != HCI_EVENT_PKT) continue;
		if (buf[1] == EVT_CMD_COMPLETE && n >= 7) {
			uint16_t op = (uint16_t)(buf[4] | (buf[5] << 8));
			if (op == want) return buf[6];
		} else if (buf[1] == EVT_CMD_STATUS && n >= 7) {
			uint16_t op = (uint16_t)(buf[5] | (buf[6] << 8));
			if (op == want) return buf[3];
		}
	}
}

static int scan_enable_legacy(int fd, int on, int wait)
{
	uint8_t p[2] = { (uint8_t)(on ? 1 : 0), 0 /* keine Duplikatfilterung: jede Messung zählt */ };
	return wait ? run_cmd(fd, OCF_SET_SCAN_ENABLE, p, 2) : send_cmd(fd, OCF_SET_SCAN_ENABLE, p, 2);
}

static int scan_enable_ext(int fd, int on, int wait)
{
	uint8_t p[6] = { (uint8_t)(on ? 1 : 0), 0, 0, 0, 0, 0 };
	return wait ? run_cmd(fd, OCF_SET_EXT_SCAN_ENABLE, p, 6) : send_cmd(fd, OCF_SET_EXT_SCAN_ENABLE, p, 6);
}

/* passiv, Intervall 60 ms, Fenster 30 ms (0,625-ms-Schritte) */
static int start_legacy(int fd)
{
	uint8_t p[7] = { 0x00, 0x60, 0x00, 0x30, 0x00, 0x00, 0x00 };
	scan_enable_legacy(fd, 0, 1);
	int st = run_cmd(fd, OCF_SET_SCAN_PARAMS, p, 7);
	if (st != 0) return st;
	return scan_enable_legacy(fd, 1, 1);
}

static int start_ext(int fd)
{
	uint8_t p[8] = { 0x00, 0x00, 0x01 /* LE 1M */, 0x00 /* passiv */, 0x60, 0x00, 0x30, 0x00 };
	scan_enable_ext(fd, 0, 1);
	int st = run_cmd(fd, OCF_SET_EXT_SCAN_PARAMS, p, 8);
	if (st != 0) return st;
	return scan_enable_ext(fd, 1, 1);
}

/* nur Pakete mit 16-bit-Service-Daten (Sensoren); Handys, Kopfhörer & Co. bleiben draußen */
static int has_service_data(const uint8_t *d, unsigned len)
{
	unsigned i = 0;
	while (i < len) {
		unsigned l = d[i];
		if (l == 0 || i + 1 + l > len) return 0;
		if (d[i + 1] == 0x16 && l >= 3) return 1;
		i += 1 + l;
	}
	return 0;
}

static void emit(const uint8_t *addr, uint8_t atype, int8_t rssi, const uint8_t *data, unsigned len)
{
	static const char hex[] = "0123456789abcdef";
	char line[16 + 18 + 8 + 2 * 255 + 4];
	int n;
	if (!has_service_data(data, len)) return;
	n = snprintf(line, sizeof(line), "A %02X:%02X:%02X:%02X:%02X:%02X %u %d ",
		addr[5], addr[4], addr[3], addr[2], addr[1], addr[0], atype, rssi);
	for (unsigned i = 0; i < len && n + 3 < (int)sizeof(line); i++) {
		line[n++] = hex[data[i] >> 4];
		line[n++] = hex[data[i] & 15];
	}
	line[n++] = '\n';
	if (fwrite(line, 1, (size_t)n, stdout) != (size_t)n) stop_flag = 1;
}

static void handle_meta(const uint8_t *e, unsigned len)
{
	if (len < 2) return;
	if (e[0] == LE_ADV_REPORT) {
		unsigned num = e[1], i = 2;
		for (unsigned r = 0; r < num; r++) {
			if (i + 9 > len) return;
			const uint8_t atype = e[i + 1];
			const uint8_t *addr = e + i + 2;
			unsigned dlen = e[i + 8];
			if (i + 9 + dlen + 1 > len) return;
			emit(addr, atype, (int8_t)e[i + 9 + dlen], e + i + 9, dlen);
			i += 9 + dlen + 1;
		}
	} else if (e[0] == LE_EXT_ADV_REPORT) {
		unsigned num = e[1], i = 2;
		for (unsigned r = 0; r < num; r++) {
			if (i + 24 > len) return;
			const uint8_t atype = e[i + 2];
			const uint8_t *addr = e + i + 3;
			int8_t rssi = (int8_t)e[i + 13];
			unsigned dlen = e[i + 23];
			if (i + 24 + dlen > len) return;
			emit(addr, atype, rssi, e + i + 24, dlen);
			i += 24 + dlen;
		}
	}
}

int main(int argc, char **argv)
{
	int dev = argc > 1 ? atoi(argv[1]) : 0;
	struct sockaddr_hci a;
	struct hci_ufilter f;
	struct sigaction sa;
	const char *mode = "legacy";
	time_t last_enable;
	uint8_t buf[512];

	if (dev < 0 || dev > 15) dev = 0;
	setvbuf(stdout, NULL, _IOLBF, 0);
	memset(&sa, 0, sizeof(sa));
	sa.sa_handler = on_signal;
	sigaction(SIGTERM, &sa, NULL);
	sigaction(SIGINT, &sa, NULL);
	signal(SIGPIPE, SIG_IGN);

	int fd = socket(AF_BLUETOOTH, SOCK_RAW | SOCK_CLOEXEC, BTPROTO_HCI);
	if (fd < 0) { printf("E socket %d\n", errno); return 2; }
	if (ioctl(fd, HCIDEVUP, dev) < 0 && errno != EALREADY) {
		/* schon an, oder keine Berechtigung – das Binden zeigt, ob es trotzdem geht */
	}
	memset(&a, 0, sizeof(a));
	a.hci_family = AF_BLUETOOTH;
	a.hci_dev = (unsigned short)dev;
	a.hci_channel = HCI_CHANNEL_RAW;
	if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0) { printf("E bind %d\n", errno); return 2; }
	memset(&f, 0, sizeof(f));
	f.type_mask = 1u << HCI_EVENT_PKT;
	f.event_mask[0] = (1u << EVT_CMD_COMPLETE) | (1u << EVT_CMD_STATUS);
	f.event_mask[1] = 1u << (EVT_LE_META - 32);
	if (setsockopt(fd, SOL_HCI, HCI_FILTER, &f, sizeof(f)) < 0) { printf("E filter %d\n", errno); return 2; }

	int st = start_legacy(fd);
	if (st != 0) {
		int st2 = start_ext(fd);
		if (st2 == 0) { mode_ext = 1; mode = "extended"; }
		else if (st == HCI_CMD_DISALLOWED || st2 == HCI_CMD_DISALLOWED) mode = "shared"; /* ein anderer scannt schon – wir hören mit */
		else { printf("E scan %d\n", st < 0 ? st2 : st); close(fd); return 2; }
	}
	printf("S ready %s hci%d\n", mode, dev);
	last_enable = time(NULL);

	while (!stop_flag) {
		struct pollfd p = { .fd = fd, .events = POLLIN };
		int r = poll(&p, 1, 1000);
		if (r < 0) { if (errno == EINTR) continue; break; }
		if (r > 0) {
			ssize_t n = read(fd, buf, sizeof(buf));
			if (n < 0) { if (errno == EINTR || errno == EAGAIN) continue; printf("E read %d\n", errno); break; }
			if (n >= 3 && buf[0] == HCI_EVENT_PKT && buf[1] == EVT_LE_META) {
				unsigned plen = buf[2];
				if (3u + plen <= (unsigned)n) handle_meta(buf + 3, plen);
			}
		}
		/* falls jemand (bluetoothd) den Scan abgeschaltet hat: alle 2 Minuten wieder an */
		if (time(NULL) - last_enable >= 120) {
			if (mode_ext) scan_enable_ext(fd, 1, 0); else scan_enable_legacy(fd, 1, 0);
			last_enable = time(NULL);
		}
	}
	if (strcmp(mode, "shared") != 0) { if (mode_ext) scan_enable_ext(fd, 0, 1); else scan_enable_legacy(fd, 0, 1); }
	close(fd);
	return 0;
}
