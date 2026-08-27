#include <stdint.h>

struct Pixel {
	uint8_t r;
	uint8_t g;
	uint8_t b;
};

struct Pixel frame[4] = {
	{255, 0, 0},
	{0, 255, 0},
	{0, 0, 255},
	{255, 255, 255},
};

char message[] = "aidb views";

struct Sample {
	int id;
	float value;
};

struct Sample sample = {7, 3.5f};

int main(void) {
	volatile int computed = frame[0].r + frame[1].g + frame[2].b;
	return computed == 510 && message[0] == 'a' && sample.id == 7 ? 0 : 1;
}
