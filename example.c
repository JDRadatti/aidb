// THsi is a comment
#include <stdio.h>

int func(int x, float y)
{
    return x + y;
}

int main(void) 
{
    int lets_do = 0;
    int some_math = 10;
    int g = lets_do + some_math;
    float f = 10.0;
    float can_i_add_int_and_float = func(f, lets_do);

    printf("I guess I can %f", can_i_add_int_and_float);

    int total = 0;
    for (int i = 0; i < 10; i++) 
    {
        total += i;
    }
    return 0;
}
