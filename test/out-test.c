#include <stdio.h>
#include <unistd.h>
int main(void) {
    for (int i = 1; i <= 3; i++) {
        printf("tick %d\n", i);
        fflush(stdout);
        sleep(1);
    }
    printf("no-newline-end ");
    return 0;
}
