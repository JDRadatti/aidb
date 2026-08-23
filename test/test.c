/**
 * Simple test program for the debugger.
 * Has a deliberate off-by-one bug in the sum function.
 */

#include <stdio.h>
#include <stdlib.h>

int sum_array(int *arr, int n) {
    int sum = 0;
    for (int i = 0; i <= n; i++) {  // BUG: should be i < n
        sum += arr[i];
    }
    return sum;
}

int main(int argc, char *argv[]) {
    int values[] = {10, 20, 30, 40, 50};
    int count = 5;

    printf("Computing sum of %d values...\n", count);

    int result = sum_array(values, count);

    printf("Result: %d\n", result);
    printf("Expected: 150\n");

    if (result != 150) {
        printf("BUG: Got %d instead of 150!\n", result);
        return 1;
    }

    printf("All good!\n");
    return 0;
}
