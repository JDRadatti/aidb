#include <stdio.h>

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    volatile int sum = 0;
    for (int i = 0; i < 1000; i++) {
        sum += i;
        sum += 1;
        sum += 2;
        sum += 3;
        sum += 4;
        sum += 5;
        sum += 6;
        sum += 7;
        sum += 8;
        sum += 9;
    }
    printf("sum=%d\n", sum);
    return 0;
}
