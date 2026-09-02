// THsi is a comment
#include <iostream>

int add(int x, int y);

int getValueFromUser() {
  int x = 0;
  std::cin >> x;
  return x;
}

int doubleInteger(int i) { return i * 2; }

#define bool int
#define true 1
#define false 0

struct Player {
  int x;
  int y[2];
  char z[2];
};

int main(void) {
  char ch = 'A';
  bool ok = 1;
  double f = 3.14;
  struct Player p = {99, {3, 4}, {'h', 'i'}};
  int ints[4] = {1, 2, 3, 4};
  char msg[16] = "hello";
  const char *s = "world";
  ch = 'b';
  ok = false;
  f = 2.16;
  p = {};
  ints[0] = 0;
  msg[0] = 'H';

  std::cout << s << ch << ok << f << p.x << ints[0] << msg[0] << '\n';
  // //    int lets_do;
  //     lets_do = 10;
  //     float f = 10.0;s;
  //     printf("float %f, lets_do %d", f, lets_do);
  //
  //     int total = 0;
  //     for (int i = 0; i < 10; i++)
  //     {
  //         total += i;
  //     }
  //     return 0;

  // get input
  // double input
  // check diff between ++x x++ and x += 1
  int input = getValueFromUser();
  int doubledInput = doubleInteger(input);
  std::cout << "Doubled input: " << doubledInput << "\n";

  int b = ++input;
  int c = input++;
  int d = input += 1;
  int e = add(input, 100);

  std::cout << b << "\n";
  std::cout << c << "\n";
  std::cout << d << "\n";
  std::cout << e << "\n";

  // // // NOTE: this does not work. 
  // // const int x{3};
  // // int *ptr = &x;
  // // std::cout << ptr << " " << *ptr << "\n";
  // //
  // // NOTE: this also does not work. 
  // // cannot change a pointed to value if const
  // const int x{3};
  // const int *ptr = &x;
  // *ptr = 4;
  // std::cout << " " << x << ptr << " " << *ptr << "\n";
  //
  //
  //NOTE: This works! you can change the pointer value, but not the pointed to value
  // const int x{3};
  // const int y{5};
  // const int *ptr = &x;
  // ptr = &y;
  // std::cout << " " << x << " " << ptr << " " << *ptr << "\n";

  return 0;
}
